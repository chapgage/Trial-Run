import { createClient } from '@supabase/supabase-js'

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// Service-role client. Bypasses RLS: only ever used inside these serverless functions.
export function adminClient() {
  if (!url || !serviceKey) {
    throw new HttpError(500, 'Server is missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.')
  }
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

function bearer(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : null
}

// Verify the caller's Supabase session and league membership.
export async function requireMember(req, { commissioner = false } = {}) {
  const token = bearer(req)
  if (!token) throw new HttpError(401, 'Sign in required.')
  const admin = adminClient()
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Sign in again.')
  const { data: member, error: mErr } = await admin
    .from('ffl_members')
    .select('*')
    .eq('user_id', data.user.id)
    .maybeSingle()
  if (mErr) throw mErr
  if (!member) throw new HttpError(403, 'You are not a member of this league.')
  if (commissioner && !member.is_commissioner) throw new HttpError(403, 'Commissioner only.')
  return { admin, user: data.user, member }
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
