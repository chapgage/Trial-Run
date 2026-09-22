import { createClient } from '@supabase/supabase-js'

// Both values are PUBLIC and safe to ship to the browser.
// They are injected at build time from environment variables (see .env.example).
// Never put the service_role key or any other secret in this project.
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isConfigured = Boolean(url && anonKey)

export const supabase = isConfigured ? createClient(url, anonKey) : null
