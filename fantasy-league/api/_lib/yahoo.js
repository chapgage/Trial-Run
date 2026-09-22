import { HttpError } from './supabase.js'

const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth'
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token'
const API_URL = 'https://fantasysports.yahooapis.com/fantasy/v2'

function credentials() {
  const id = process.env.YAHOO_CLIENT_ID
  const secret = process.env.YAHOO_CLIENT_SECRET
  if (!id || !secret) throw new HttpError(500, 'Yahoo is not configured yet (YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET).')
  return { id, secret }
}

export function redirectUri(req) {
  if (process.env.YAHOO_REDIRECT_URI) return process.env.YAHOO_REDIRECT_URI
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const proto = req.headers['x-forwarded-proto'] || 'https'
  return `${proto}://${host}/api/yahoo/callback`
}

export function authUrl(req, state) {
  const { id } = credentials()
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    state,
  })
  return `${AUTH_URL}?${params}`
}

async function tokenRequest(req, params) {
  const { id, secret } = credentials()
  const body = new URLSearchParams({ ...params, redirect_uri: redirectUri(req) })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new HttpError(502, `Yahoo token error: ${json.error_description || json.error || res.status}`)
  }
  return json
}

export function exchangeCode(req, code) {
  return tokenRequest(req, { grant_type: 'authorization_code', code })
}

export async function saveTokens(admin, tokens) {
  const row = {
    id: 1,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000).toISOString(),
    yahoo_guid: tokens.xoauth_yahoo_guid || null,
    updated_at: new Date().toISOString(),
  }
  const { error } = await admin.from('ffl_yahoo_tokens').upsert(row)
  if (error) throw error
  return row
}

export async function tokenRow(admin) {
  const { data, error } = await admin.from('ffl_yahoo_tokens').select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  return data
}

// Returns a valid access token, refreshing it when it has expired.
export async function accessToken(admin, req) {
  const row = await tokenRow(admin)
  if (!row) throw new HttpError(409, 'Yahoo is not connected yet. The commissioner can connect it in Settings.')
  if (new Date(row.expires_at) > new Date()) return row.access_token
  const fresh = await tokenRequest(req, { grant_type: 'refresh_token', refresh_token: row.refresh_token })
  const saved = await saveTokens(admin, { ...fresh, refresh_token: fresh.refresh_token || row.refresh_token })
  return saved.access_token
}

export async function yahooGet(token, path) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await fetch(`${API_URL}/${path}${sep}format=json`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new HttpError(502, `Yahoo API ${res.status}: ${text.slice(0, 160) || res.statusText}`)
  }
  return res.json()
}

// ----- Yahoo JSON helpers -----
// Yahoo returns objects as arrays of single-key objects, and lists as {"0": ..., "1": ..., "count": n}.

function merge(list) {
  const out = {}
  for (const item of Array.isArray(list) ? list : []) {
    if (Array.isArray(item)) Object.assign(out, merge(item))
    else if (item && typeof item === 'object') Object.assign(out, item)
  }
  return out
}

function items(obj) {
  if (!obj || typeof obj !== 'object') return []
  return Object.keys(obj)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => obj[k])
}

function num(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function parseScoreboard(json) {
  const league = merge(json?.fantasy_content?.league)
  const scoreboard = league.scoreboard || {}
  const matchups = items(scoreboard['0']?.matchups).map(({ matchup }) => {
    const m = matchup || {}
    const teams = items(m['0']?.teams).map(({ team }) => {
      const t = merge(team)
      const managers = items(t.managers).map((x) => x.manager?.nickname).filter(Boolean)
      const logo = items(t.team_logos)[0]?.team_logo?.url || t.team_logos?.[0]?.team_logo?.url || null
      return {
        key: t.team_key,
        id: t.team_id,
        name: t.name,
        logo,
        managers,
        points: num(t.team_points?.total),
        projected: num(t.team_projected_points?.total),
        winProbability: t.win_probability != null ? num(t.win_probability) : null,
      }
    })
    return {
      week: m.week,
      status: m.status,
      isPlayoffs: String(m.is_playoffs) === '1',
      isTied: String(m.is_tied) === '1',
      winnerKey: m.winner_team_key || null,
      teams,
    }
  })
  return {
    league: {
      key: league.league_key,
      name: league.name,
      season: league.season,
      currentWeek: num(league.current_week),
      scoringType: league.scoring_type,
      url: league.url,
    },
    week: num(scoreboard.week) ?? num(league.current_week),
    matchups,
  }
}

export function parseLeagues(json) {
  const user = merge(json?.fantasy_content?.users?.['0']?.user)
  const out = []
  for (const g of items(user.games)) {
    const game = merge(g.game)
    for (const l of items(game.leagues)) {
      const league = merge(l.league)
      if (!league.league_key) continue
      out.push({
        key: league.league_key,
        name: league.name,
        season: league.season,
        numTeams: num(league.num_teams),
        url: league.url,
        isFinished: String(league.is_finished) === '1',
      })
    }
  }
  return out
}

// Compact, human-readable scoreboard for the burn writer.
export function describeScoreboard(sb) {
  if (!sb?.matchups?.length) return 'No matchup data available.'
  const lines = sb.matchups.map((m) => {
    const [a, b] = m.teams
    const fmt = (t) => `${t.name}${t.managers.length ? ` (${t.managers.join('/')})` : ''} ${t.points ?? '—'}${t.projected != null ? ` [proj ${t.projected}]` : ''}`
    const status = { preevent: 'not started', midevent: 'LIVE', postevent: 'final' }[m.status] || m.status
    return `- ${fmt(a)} vs ${fmt(b)} — ${status}`
  })
  return `Week ${sb.week} of ${sb.league?.name || 'the league'}:\n${lines.join('\n')}`
}
