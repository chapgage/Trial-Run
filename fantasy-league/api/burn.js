import Anthropic from '@anthropic-ai/sdk'
import { serverClient, requireMember, isCronCall, sendError, methodGuard, HttpError, db } from './_lib/supabase.js'
import { describeScoreboard } from './_lib/yahoo.js'
import { loadScoreboard } from './scoreboard.js'

const MODEL = 'claude-opus-5'
const CHAT_WINDOW = 40          // how many recent messages the roastmaster reads
const COOLDOWN_MS = 3 * 60_000  // skip automatic burns if one landed very recently

const SYSTEM_PROMPT = `You are the resident roastmaster for a private Yahoo fantasy football league. The members are friends who talk trash for sport, and your job is to keep the group chat spicy.

Each time you're called, you get the live scoreboard, the member list, and the most recent chat messages. Write ONE burn:
- Pick a target who deserves it right now: someone losing badly, someone whose big talk in chat isn't matching their score, someone who went quiet after a bold prediction, or whoever the chat is already ganging up on. Use the exact display name from the member list.
- Ground it in specifics: quote or paraphrase something they actually said, cite a real score or projection, name the matchup. Invented facts kill the joke.
- Tone: sharp, funny, confident, PG-13. Punch at fantasy decisions, hot takes, and bravado. Never touch appearance, family, health, race, religion, sexuality, jobs, money, or anything from outside the league. No slurs, no cruelty. If someone in chat seems genuinely upset about something real, pick a different target or roast the whole league instead.
- Also write a "prompt": one line that restarts the conversation. A question the target has to answer, a dare, or a poll for the league ("Over/under 3 more weeks before X benches his kicker?").

Keep it tight: headline under 70 characters, burn one to three sentences, prompt one sentence. Return JSON only.`

const OUTPUT_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Display name of the member being roasted, or "The whole league".' },
      headline: { type: 'string' },
      burn: { type: 'string' },
      prompt: { type: 'string' },
    },
    required: ['target', 'headline', 'burn', 'prompt'],
    additionalProperties: false,
  },
}

function buildUserMessage({ leagueName, scoreboardText, members, messages }) {
  const roster = members
    .map((m) => `- ${m.display_name}${m.team_name ? ` — Yahoo team "${m.team_name}"` : ''}${m.is_commissioner ? ' (commissioner)' : ''}`)
    .join('\n')
  const chat = messages.length
    ? messages
        .map((m) => `[${new Date(m.created_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}] ${m.name}: ${m.body}`)
        .join('\n')
    : '(The chat has been quiet. Roast the silence, or whoever the scoreboard says is having a bad day.)'
  return `League: ${leagueName}

SCOREBOARD
${scoreboardText}

MEMBERS
${roster}

RECENT CHAT (oldest first)
${chat}

Write the burn now.`
}

async function writeBurn(client, userMessage) {
  const base = {
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'medium', format: OUTPUT_FORMAT },
    messages: [{ role: 'user', content: userMessage }],
  }
  let response
  try {
    // Server-side fallback: if Claude Opus 5's safety classifiers decline the request,
    // the API re-runs it on Anthropic's recommended fallback model instead of failing.
    response = await client.beta.messages.create({
      ...base,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err
    response = await client.messages.create(base)
  }
  if (response.stop_reason === 'refusal') {
    throw new HttpError(502, 'The roastmaster declined to write this one. Try again after a few more messages.')
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new HttpError(502, 'The roastmaster returned something unreadable.')
    return JSON.parse(match[0])
  }
}

// POST /api/burn  { force?: boolean }   (members)   -> { burn } or { skipped: true, burn }
// GET  /api/burn  Authorization: Bearer <CRON_SECRET>  (Vercel Cron)
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST', 'GET'])) return
  try {
    let client, member = null, source
    if (req.method === 'GET') {
      if (!isCronCall(req)) throw new HttpError(401, 'Cron secret required.')
      client = serverClient()
      source = 'cron'
    } else {
      ;({ client, member } = await requireMember(req))
      source = req.body?.force ? 'manual' : 'auto'
    }

    if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(500, 'ANTHROPIC_API_KEY is not set on the server.')

    const ctx = await db.chatContext(client, CHAT_WINDOW)
    const latest = ctx.latest_burn || null
    if (source !== 'manual' && latest && Date.now() - new Date(latest.created_at).getTime() < COOLDOWN_MS) {
      return res.status(200).json({ skipped: true, burn: latest })
    }

    const members = ctx.members || []
    const names = new Map(members.map((m) => [m.user_id, m.display_name]))
    const messages = (ctx.messages || []).map((m) => ({ ...m, name: names.get(m.user_id) || 'Someone' }))

    if (source === 'auto' && latest && !messages.some((m) => m.id > (latest.last_message_id ?? 0))) {
      return res.status(200).json({ skipped: true, burn: latest })
    }

    let scoreboardText = 'Scoreboard unavailable right now.'
    try {
      scoreboardText = describeScoreboard(await loadScoreboard(client, req))
    } catch (err) {
      console.warn('scoreboard unavailable for burn:', err.message)
    }

    const anthropic = new Anthropic()
    const result = await writeBurn(anthropic, buildUserMessage({
      leagueName: ctx.league?.name || 'The League',
      scoreboardText,
      members,
      messages,
    }))

    const burn = await db.insertBurn(client, {
      target: String(result.target || '').slice(0, 80) || null,
      headline: String(result.headline || 'Burn').slice(0, 140),
      burn: String(result.burn || '').slice(0, 1200),
      prompt: String(result.prompt || '').slice(0, 400),
      source,
      requested_by: member?.user_id || null,
      last_message_id: messages.length ? messages[messages.length - 1].id : latest?.last_message_id ?? null,
    })

    res.status(200).json({ burn })
  } catch (err) {
    sendError(res, err)
  }
}
