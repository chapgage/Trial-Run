import { createClient } from '@supabase/supabase-js'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const serverSecret = process.env.FFL_SERVER_SECRET

function assertConfigured() {
  if (!url || !anonKey) throw new HttpError(500, 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY.')
  if (!serverSecret) throw new HttpError(500, 'Server is missing FFL_SERVER_SECRET.')
}

// A Supabase client for the server. With a user token it acts as that user (RLS applies);
// without one it can only call the ffl_server_* functions, which check FFL_SERVER_SECRET.
export function serverClient(userToken = null) {
  assertConfigured()
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: userToken ? { headers: { Authorization: `Bearer ${userToken}` } } : {},
  })
}

async function serverRpc(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, { secret: serverSecret, ...args })
  if (error) throw new HttpError(500, `Database error in ${fn}: ${error.message}`)
  return data
}

// Server-only data access. Every call goes through a SECURITY DEFINER function that
// verifies the shared secret, so no service_role key is needed anywhere.
export const db = {
  yahooTokens: (c) => serverRpc(c, 'ffl_server_get_yahoo_tokens').then((rows) => rows?.[0] || null),
  saveYahooTokens: (c, row) => serverRpc(c, 'ffl_server_save_yahoo_tokens', {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
    yahoo_guid: row.yahoo_guid ?? null,
  }),
  league: (c) => serverRpc(c, 'ffl_server_get_league').then((rows) => rows?.[0] || null),
  setLeagueKey: (c, league_key) => serverRpc(c, 'ffl_server_set_league_key', { league_key }),
  insertBurn: (c, burn) => serverRpc(c, 'ffl_server_insert_burn', burn),
  chatContext: (c, message_limit) => serverRpc(c, 'ffl_server_chat_context', { message_limit }),
  manualScores: (c) => serverRpc(c, 'ffl_server_get_manual_scores').then((rows) => rows?.[0] || null),
}

function bearer(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

// Verify the caller's Supabase session and league membership.
export async function requireMember(req, { commissioner = false } = {}) {
  const token = bearer(req)
  if (!token) throw new HttpError(401, 'Sign in required.')
  const client = serverClient(token)
  const { data, error } = await client.auth.getUser(token)
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Sign in again.')
  // Runs under RLS as the user: non-members get no row back.
  const { data: member, error: mErr } = await client
    .from('ffl_members')
    .select('*')
    .eq('user_id', data.user.id)
    .maybeSingle()
  if (mErr) throw new HttpError(500, mErr.message)
  if (!member) throw new HttpError(403, 'You are not a member of this league.')
  if (commissioner && !member.is_commissioner) throw new HttpError(403, 'Commissioner only.')
  return { client, user: data.user, member }
}

// True when Vercel Cron (or anyone holding CRON_SECRET) is calling.
export function isCronCall(req) {
  const secret = process.env.CRON_SECRET
  return Boolean(secret) && bearer(req) === secret
}

export function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500
  if (status >= 500) console.error(err)
  res.status(status).json({ error: err.message || 'Something went wrong.' })
}

export function methodGuard(req, res, methods) {
  if (methods.includes(req.method)) return true
  res.setHeader('Allow', methods.join(', '))
  res.status(405).json({ error: `Use ${methods.join(' or ')}.` })
  return false
}
