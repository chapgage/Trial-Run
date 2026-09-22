# League HQ

Private website for a Yahoo fantasy football league. Members sign in with an invite code and get:

- **Scoreboard**: this week's matchups from Yahoo Fantasy, with live points, projections and win probability. Refreshes every minute. While Yahoo API approval is pending (Yahoo gates Fantasy Sports API access behind an application since mid-2026), the commissioner can type the week's matchups into Settings and the site uses those instead.
- **Chat**: a realtime league group chat.
- **Burn board**: a Claude-written roast ("burn") plus a discussion prompt, grounded in the live scores and whatever the chat has been saying. One is written automatically every 8 chat messages, on demand with the 🔥 button, and once a week by a Sunday cron.

Built with [Vite](https://vite.dev), hosted on [Vercel](https://vercel.com) (static site + serverless functions in `api/`), data and auth in [Supabase](https://supabase.com), burns by the [Claude API](https://docs.claude.com).

## How access works

1. The commissioner shares the **invite code** (or the invite link, which pre-fills it) with league members only.
2. A member fills in the "New here? Join" form: invite code, name, email, password. The `ffl-signup` edge function (in `supabase/functions/`) checks the code, creates the login already confirmed so no email link is needed, and adds their `ffl_members` row. They are signed in immediately.
3. Every table is protected by Row Level Security: without a member row you cannot read or write anything, even with a valid login. The Yahoo tokens table has no client policies at all and is only touched by the serverless functions.
4. The **first person to join becomes commissioner**. The commissioner sees Settings: league name, invite code, and the Yahoo connection.

## One-time setup

### 1. Supabase

The schema is in `supabase/migrations/` and the signup function in `supabase/functions/ffl-signup/`. Both are already deployed to the league's Supabase project. For a fresh project: run the migrations in the SQL editor, insert a row into `ffl_server_secret`, and deploy the function with `supabase functions deploy ffl-signup --no-verify-jwt` (it must accept the publishable key, which is not a JWT; the invite code is its authentication).

Accounts are created by that function with `email_confirm: true`, so Supabase's built-in email service (limited to a few messages per hour, and only to project owners on new projects) is never used. Password resets would still need email; set up custom SMTP under **Authentication → SMTP Settings** if you want those.

### 2. Yahoo developer app

Yahoo has no API keys per user; the site uses OAuth and the commissioner connects once. **Since 2026 Yahoo requires approval for Fantasy Sports API access**: apply at <https://sports.yahoo.com/developer/access/> (personal / single-league use is allowed) and sign the API Access and Use Agreement. Until approved, every fantasy endpoint returns 403 "This application is not authorized to perform this action" and the site falls back to manually entered scores.

1. Go to <https://developer.yahoo.com/apps/create/> and sign in with the Yahoo account that owns the league.
2. Application type: **Web Application**. Redirect URI(s): `https://<your-vercel-domain>/api/yahoo/callback`. API permissions: **Fantasy Sports → Read**.
3. Copy the **Client ID** and **Client Secret** into the Vercel environment variables below.
4. After deploying, open the site as commissioner → Settings → **Connect Yahoo account**. If the account is in more than one active NFL league, click **Find my leagues** and pick the right one.

### 3. Claude API key

Create a key at <https://platform.claude.com/> and set `ANTHROPIC_API_KEY`. The burn writer uses `claude-opus-5` with server-side fallback enabled, so a request the model's safety filters decline is re-run on Anthropic's recommended fallback model instead of failing.

### 4. Vercel environment variables

| Name | Where it's used | Value |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | browser | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | browser | Supabase anon / publishable key |
| `SUPABASE_URL` | functions | same project URL |
| `SUPABASE_ANON_KEY` | functions | same anon / publishable key |
| `FFL_SERVER_SECRET` | functions | random string that must equal the value in the `ffl_server_secret` table. Secret. |
| `ANTHROPIC_API_KEY` | functions | Claude API key. Secret. |
| `YAHOO_CLIENT_ID` | functions | from the Yahoo app |
| `YAHOO_CLIENT_SECRET` | functions | from the Yahoo app. Secret. |
| `CRON_SECRET` | functions | any long random string; Vercel sends it with the weekly cron call |
| `YAHOO_LEAGUE_KEY` | functions, optional | pin a league, e.g. `nfl.l.123456`, instead of auto-discovering |
| `YAHOO_REDIRECT_URI` | functions, optional | only if the callback must use a different domain |

Set them for **Production** and **Preview**. Redeploy after changing any `VITE_` value (those are baked in at build time).

## Local development

```bash
npm install
cp .env.example .env   # fill in the values
npx vercel dev         # runs Vite + the api/ functions together on http://localhost:3000
```

`npm run dev` runs the frontend only; API calls will 404 without `vercel dev`.

```bash
npm test        # Yahoo payload parser tests
npm run build   # production build into dist/
```

## Layout

```
index.html, src/        Vite frontend (vanilla JS, no framework)
  main.js               auth screens, join gate, scoreboard, chat, burn board, settings
  api.js                fetch wrapper that sends the Supabase session token to api/
api/                    Vercel serverless functions (Node, ESM)
  scoreboard.js         GET  members   Yahoo scoreboard for the current week (45s cache)
  burn.js               POST members   write a burn from chat + scores; GET for the weekly cron
  yahoo/connect.js      POST commish   start Yahoo OAuth
  yahoo/callback.js     GET            Yahoo redirects here; stores tokens, picks the league
  yahoo/leagues.js      GET  commish   connection status, optional league discovery
  _lib/supabase.js      server client, ffl_server_* data helpers, membership check
  _lib/yahoo.js         token refresh, API calls, payload parsing
supabase/migrations/    schema, RLS policies, join function
test/                   node:test unit tests
```

## Data model

| Table | Purpose | Who can access from the browser |
| --- | --- | --- |
| `ffl_league` | single row: name, invite code, Yahoo league key | commissioner (read/update) |
| `ffl_members` | one row per member; first joiner is commissioner | members read; each updates own row |
| `ffl_messages` | chat | members read; insert as self |
| `ffl_burns` | generated burns | members read; server inserts |
| `ffl_yahoo_tokens` | Yahoo OAuth tokens | nobody; server only via `ffl_server_*` functions |
| `ffl_server_secret` | the shared secret the server presents | nobody |
| `ffl_manual_scores` | commissioner-typed matchups per week (fallback) | members read; commissioner writes |

Members are created by the `ffl-signup` edge function (service role, checks the invite code). `ffl_join_league(code, display_name, team_name)` remains for an existing login that has no member row yet.

To rotate the server secret: generate a new random string, `update ffl_server_secret set secret = '...'`, set the same value as `FFL_SERVER_SECRET` in Vercel, and redeploy.
