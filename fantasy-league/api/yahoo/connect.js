import { randomUUID } from 'node:crypto'
import { requireMember, sendError, methodGuard } from '../_lib/supabase.js'
import { authUrl } from '../_lib/yahoo.js'

// POST /api/yahoo/connect  (commissioner) -> { url } to start Yahoo's login flow.
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return
  try {
    await requireMember(req, { commissioner: true })
    const state = randomUUID()
    res.setHeader('Set-Cookie', `ffl_oauth_state=${state}; Path=/api/yahoo; HttpOnly; Secure; SameSite=Lax; Max-Age=600`)
    res.status(200).json({ url: authUrl(req, state) })
  } catch (err) {
    sendError(res, err)
  }
}
