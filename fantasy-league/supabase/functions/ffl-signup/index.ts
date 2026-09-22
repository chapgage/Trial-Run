// Supabase Edge Function: create a league member without any confirmation email.
// The browser posts { email, password, display_name, team_name?, code } with the anon key.
// The invite code is the authentication; the function runs with the service role,
// which Supabase injects into edge functions automatically.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

// Light brute-force protection for the invite code: 10 attempts per IP per 10 minutes.
const attempts = new Map<string, { n: number; at: number }>();
function tooMany(ip: string) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.at > 10 * 60_000) { attempts.set(ip, { n: 1, at: now }); return false; }
  rec.n += 1;
  return rec.n > 10;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only." });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  if (tooMany(ip)) return json(429, { error: "Too many attempts. Try again in a few minutes." });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "Bad request." }); }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const display_name = String(body.display_name ?? "").trim().slice(0, 40);
  const team_name = String(body.team_name ?? "").trim().slice(0, 60) || null;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: "Enter a valid email address." });
  if (password.length < 8) return json(400, { error: "Password needs at least 8 characters." });
  if (!display_name) return json(400, { error: "Tell the league your name." });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: league, error: lErr } = await admin.from("ffl_league").select("invite_code").eq("id", 1).maybeSingle();
  if (lErr || !league) return json(500, { error: "The league has not been set up yet." });
  if (norm(body.code) !== norm(league.invite_code)) return json(403, { error: "That invite code is not right." });

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name },
  });
  if (cErr) {
    if (cErr.status === 422 || /already|exist|registered/i.test(cErr.message || "")) {
      return json(409, { error: "An account with that email already exists. Use Sign in instead." });
    }
    return json(500, { error: `Could not create the account: ${cErr.message}` });
  }

  const { count } = await admin.from("ffl_members").select("user_id", { count: "exact", head: true });
  const is_commissioner = (count ?? 0) === 0;
  const { error: mErr } = await admin.from("ffl_members").insert({
    user_id: created.user.id,
    display_name,
    team_name,
    is_commissioner,
  });
  if (mErr) {
    return json(500, { error: `Account created, but joining failed (${mErr.message}). Sign in and enter the invite code.` });
  }

  return json(200, { ok: true, is_commissioner });
});
