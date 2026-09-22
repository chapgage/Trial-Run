# YPO Workshop

Starter website built with [Vite](https://vite.dev), hosted on [Vercel](https://vercel.com), and connected to a [Supabase](https://supabase.com) database.

The home page shows a small guestbook: it reads recent entries from the `guestbook` table and lets visitors add their own.

## Local development

```bash
npm install
cp .env.example .env   # then fill in the two values
npm run dev
```

## Environment variables

| Name | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL (public) |
| `VITE_SUPABASE_ANON_KEY` | Supabase publishable / anon key (public) |

Both are public values that are safe to ship to the browser. They are set in the Vercel project settings, not in the code.

**Never** put the Supabase `service_role` key or any other secret in this repository.

## Deployment

The site is deployed to Vercel as the `ypo-workshop` project. Production URL: https://ypo-workshop-sgc24.vercel.app

Vercel is linked to this GitHub repository. Every push to `main` builds and deploys to production automatically.

## Database

The `guestbook` table lives in the `public` schema with Row Level Security enabled:

- anyone can read entries
- anyone can insert an entry
- nobody can update or delete from the browser

The migration is recorded in the Supabase project (`create_guestbook`).

## Also in this repo: League HQ (`fantasy-league/`)

A second, separate site for a Yahoo fantasy football league: invite-only login, live Yahoo scoreboard, realtime chat, and Claude-written "burns". It has its own Supabase project, its own Vercel project (root directory `fantasy-league`), and its own README with setup steps: [fantasy-league/README.md](fantasy-league/README.md).
