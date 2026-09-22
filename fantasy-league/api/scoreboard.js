import { requireMember, sendError, methodGuard, HttpError, db } from './_lib/supabase.js'
import { accessToken, yahooGet, parseScoreboard } from './_lib/yahoo.js'

const CACHE_MS = 45_000
let cache = { key: null, at: 0, data: null }

export async function loadScoreboard(client, req, week) {
  const league = await db.league(client)
  const leagueKey = league?.yahoo_league_key || process.env.YAHOO_LEAGUE_KEY
  if (!leagueKey) throw new HttpError(409, 'No Yahoo league chosen yet. The commissioner can pick one in Settings.')

  const cacheKey = `${leagueKey}:${week || 'current'}`
  if (cache.key === cacheKey && Date.now() - cache.at < CACHE_MS) return cache.data

  const token = await accessToken(client, req)
  const path = `league/${leagueKey}/scoreboard${week ? `;week=${Number(week)}` : ''}`
  const data = parseScoreboard(await yahooGet(token, path))
  cache = { key: cacheKey, at: Date.now(), data }
  return data
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
