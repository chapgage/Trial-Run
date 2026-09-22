import { adminClient, sendError, methodGuard } from '../_lib/supabase.js'
import { exchangeCode, saveTokens, yahooGet, parseLeagues } from '../_lib/yahoo.js'

// GET /api/yahoo/callback?code=...&state=...  Yahoo sends the commissioner back here.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return
  const back = (params) => {
    res.setHeader('Set-Cookie', 'ffl_oauth_state=; Path=/api/yahoo; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
    res.redirect(302, `/?${new URLSearchParams(params)}`)
  }
  try {
    const { code, state, error, error_description } = req.query
    if (error) return back({ yahoo: 'error', message: error_description || error })
    if (!code || !state || state !== req.cookies?.ffl_oauth_state) {
      return back({ yahoo: 'error', message: 'Login state did not match. Try connecting again.' })
    }

    const admin = adminClient()
    const tokens = await exchangeCode(req, code)
    await saveTokens(admin, tokens)

    // Pick the league automatically when there is an obvious answer.
    const { data: league } = await admin.from('ffl_league').select('yahoo_league_key').eq('id', 1).maybeSingle()
    if (!league?.yahoo_league_key) {
      let key = process.env.YAHOO_LEAGUE_KEY || null
      if (!key) {
        const json = await yahooGet(tokens.access_token, 'users;use_login=1/games;game_keys=nfl/leagues')
        const leagues = parseLeagues(json).filter((l) => !l.isFinished)
        if (leagues.length === 1) key = leagues[0].key
        else return back({ yahoo: 'pick' })
      }
      await admin.from('ffl_league').update({ yahoo_league_key: key }).eq('id', 1)
    }
    return back({ yahoo: 'connected' })
  } catch (err) {
    console.error(err)
    return back({ yahoo: 'error', message: err.message || 'Unknown error' })
  }
}
