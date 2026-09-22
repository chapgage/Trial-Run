import { requireMember, sendError, methodGuard } from '../_lib/supabase.js'
import { tokenRow, accessToken, yahooGet, parseLeagues } from '../_lib/yahoo.js'

// GET /api/yahoo/leagues            (commissioner) -> connection status
// GET /api/yahoo/leagues?discover=1 (commissioner) -> also list the Yahoo account's NFL leagues
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return
  try {
    const { admin } = await requireMember(req, { commissioner: true })
    const row = await tokenRow(admin)
    const result = { connected: Boolean(row), tokenUpdatedAt: row?.updated_at || null }
    if (req.query.discover && row) {
      const token = await accessToken(admin, req)
      const json = await yahooGet(token, 'users;use_login=1/games;game_keys=nfl/leagues')
      result.leagues = parseLeagues(json)
    }
    res.status(200).json(result)
  } catch (err) {
    sendError(res, err)
  }
}
