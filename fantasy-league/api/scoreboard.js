import { requireMember, sendError, methodGuard, HttpError, db } from './_lib/supabase.js'
import { accessToken, yahooGet, parseScoreboard } from './_lib/yahoo.js'

const CACHE_MS = 45_000
let cache = { key: null, at: 0, data: null }

async function loadYahooScoreboard(client, req, week) {
  const [league, tokens] = await Promise.all([db.league(client), db.yahooTokens(client)])
  if (!tokens) throw new HttpError(409, 'Yahoo is not connected yet. The commissioner can connect it in Settings.')
  const leagueKey = league?.yahoo_league_key || process.env.YAHOO_LEAGUE_KEY
  if (!leagueKey) {
    throw new HttpError(409, 'Yahoo is connected, but no league is selected yet. If Yahoo has not approved this app for fantasy data, wait for that approval and then reconnect.')
  }
  const cacheKey = `${leagueKey}:${week || 'current'}`
  if (cache.key === cacheKey && Date.now() - cache.at < CACHE_MS) return cache.data

  const token = await accessToken(client, req)
  const path = `league/${leagueKey}/scoreboard${week ? `;week=${Number(week)}` : ''}`
  const data = { source: 'yahoo', ...parseScoreboard(await yahooGet(token, path)) }
  cache = { key: cacheKey, at: Date.now(), data }
  return data
}

async function loadManualScoreboard(client, week) {
  const row = await db.manualScores(client)
  if (!row || (week && Number(week) !== row.week)) return null
  const league = await db.league(client).catch(() => null)
  return {
    source: 'manual',
    league: { key: null, name: league?.name || 'The League', season: null, currentWeek: row.week, scoringType: null, url: null },
    week: row.week,
    matchups: row.matchups,
    updatedAt: row.updated_at,
  }
}

// Yahoo when it works; otherwise whatever the commissioner typed in Settings.
export async function loadScoreboard(client, req, week) {
  try {
    return await loadYahooScoreboard(client, req, week)
  } catch (yahooErr) {
    const manual = await loadManualScoreboard(client, week).catch(() => null)
    if (manual) return manual
    if (yahooErr instanceof HttpError && yahooErr.status === 502 && /not authorized/i.test(yahooErr.message)) {
      throw new HttpError(409, 'Yahoo has not approved this app for fantasy data yet. Until then the commissioner can type scores in Settings.')
    }
    throw yahooErr
  }
}

// GET /api/scoreboard[?week=N]  (members)
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return
  try {
    const { client } = await requireMember(req)
    const week = req.query.week && /^\d{1,2}$/.test(req.query.week) ? req.query.week : null
    const data = await loadScoreboard(client, req, week)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json(data)
  } catch (err) {
    sendError(res, err)
  }
}
