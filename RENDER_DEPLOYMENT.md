# DrShompa — Netlify + Render Deployment Guide

> Referenced by `config.js` (the old SQL Server block was removed when the project
> moved to free hosting). This is the current architecture.

## Architecture (current: ONE Render service)

```
Browser
   │  https://dr-shompa-backend.onrender.com     ← one origin, nothing else to deploy
   │  ├── /  /admin  /login  /voices | /patient-voices   sendFile() routes
   │  ├── images / CSS / fonts                          express.static()
   │  └── /api/*                                        Express routes (server.js)
   │
   └── Render Web Service "dr-shompa-backend"  +  Render Postgres "drshompa-db"
```

* **Why one service is enough:** every page calls the API with a *relative* path
  (`fetch('/api/...')`), so the frontend and the API must share an origin. Express
  already serves both — no CORS, no second host, no proxy to keep in sync.
* `render.yaml` is a Blueprint: it creates the database **and** the web service,
  injects `DATABASE_URL`, runs `setup_db.sql` on first boot and prompts you for
  `ADMIN_PASS`. See "Render — the whole app" below.

### Optional: a Netlify CDN mirror of the static pages

The same files can also live on Netlify for faster HTML delivery. Express is
*not* executed there; `/api/*` is proxied to Render so the browser still sees a
single origin:

```
Browser → https://<SITE>.netlify.app/...      static HTML/images
        → https://<SITE>.netlify.app/api/*  → PROXY → https://dr-shompa-backend.onrender.com/api/:splat
```

* Netlify never runs Node — the build is a **whitelist copy**: only the 4 public
  HTML pages + images enter `dist/`. `server.js`, `db.js`, `config.js`, `.env`,
  `appsettings.json`, `package.json` and `*.sql` are never published.
* Redirects/headers live in **three redundant places** so any deploy method works:
  `netlify.toml` (Git builds), plus `_redirects` / `_headers` copied into `dist/`
  (CLI / API direct deploys).
* A second host means a second origin: add it to the Render service's
  `ALLOWED_ORIGINS` (comma-separated), otherwise `requireSameOrigin()` rejects
  state-changing `/api` calls from it.
* Config: `netlify.toml`, `_redirects`, `_headers`. Publish dir: `dist/`.
* One-shot API deploy (no CLI needed — survives flaky networks):
  `.\deploy-netlify.ps1 -Token <NETLIFY_PAT>`
* Build command (also run by Netlify on Git push):

```bash
rm -rf dist && mkdir -p dist && cp dr-arefin-zannat-sompa.html admin.html login.html patient-voices.html dist/ && cp *.jpg *.jpeg *.png dist/ && cp _redirects _headers dist/
```

## Render — the whole app (`render.yaml` Blueprint)

| Piece | Blueprint entry |
|---|---|
| Web service `dr-shompa-backend` | under `services:` — Node runtime, free plan, `singapore`, `npm ci --omit=dev` → `node server.js`, `healthCheckPath: /api/health` |
| Postgres `drshompa-db` | under a **top-level** `databases:` — database `drshompa`, user `drshompa_user`, free plan, `singapore` |

> The database must be a top-level `databases:` entry with the service pulling
> `DATABASE_URL` through `fromDatabase:`. A `database:` key *inside* a service is
> not part of the Blueprint schema — the service then boots without a connection
> string.

Environment variables the Blueprint sets:

| Env var | Source | Why |
|---|---|---|
| `NODE_ENV=production` | fixed | strict cookie / CSP / session mode |
| `DATABASE_URL` | `fromDatabase: drshompa-db → connectionString` | `db.js` reads it; TLS comes from `DB_SSL` |
| `DB_SSL=true` | fixed | Render Postgres only accepts TLS connections |
| `DB_AUTO_MIGRATE=true` | fixed | `setup_db.sql` creates every table on first boot (idempotent) |
| `TRUST_PROXY=true` | fixed | Express must trust `X-Forwarded-Proto/Host` behind Render's proxy |
| `ADMIN_USER=admin` | fixed | CMS login |
| `ADMIN_PASS` | `sync: false` — Render prompts for it | never commit a password |
| `SESSION_SECRET` | `generateValue: true` | production needs 32+ random characters |
| `PORT` | Render, automatic | `server.js` reads `process.env.PORT` |

`region: singapore` is the closest of the five regions Render supports (Oregon,
Ohio, Virginia, Frankfurt, Singapore). A region outside that list — Bangalore,
for instance — makes the Blueprint fail.

`server.js` refuses to boot in production unless `ADMIN_USER`, `ADMIN_PASS`, a
32+ character `SESSION_SECRET` **and** an encrypted database connection are all
configured, so a missing Blueprint value shows up immediately in the deploy log.

## Deploy steps (one-time)

1. **GitHub repo** → push `main` (this repo already lives at `emslrakib/dr_shompa`).
2. **Render** → **New +** → **Blueprint** → pick the repo → `render.yaml` is
   detected → **Apply**. When asked, set `ADMIN_PASS` to a long, unique password.
3. Render now provisions Postgres, installs dependencies, starts `node server.js`
   and polls `https://dr-shompa-backend.onrender.com/api/health` until it answers
   200 — that URL is the live site.
4. Optional: add the Netlify mirror above and put its origin into the Render
   service's `ALLOWED_ORIGINS`.

## Verify after every deploy

1. `https://dr-shompa-backend.onrender.com/` → home page (title: "Dr. Arefin Zannat
   Sompa — Consultant Psychiatrist, Sylhet").
2. `/api/health` → `{"success":true,"server":"up","database":"connected",...}`.
   `"database":"unavailable"` means the `DATABASE_URL` wiring is wrong.
3. `/admin` in a browser → redirected to `/login`; sign in with `ADMIN_USER` /
   `ADMIN_PASS` → the stats panel loads (proves cookie + session + Origin path).
4. Home page appointment form → submit → success toast (proves the public POST).
5. `/voices` → patient voices page.

Before pushing, run the same checks on the local machine with the production
environment: `.\_validate_hosting.ps1` (add `-DatabaseUrl <url>` to also prove the
live data path). It validates this Blueprint too, so a broken `render.yaml` fails
on the desktop instead of in Render.

## Operational notes

* Render deletes a **free Postgres instance 30 days after creation** (free-tier
  limit). For a permanent clinic site keep the Render web service but move the
  database to a free provider without expiry (Neon / Supabase) and set
  `DATABASE_URL` on the service instead of `fromDatabase:`.
* The free web service **spins down** after inactivity: the first request after
  idle takes ~30–50 s. Render's health check and Netlify's 100 s proxy timeout are
  both comfortable with that.
* Sessions are in-memory (signed cookie + an in-process session map) and live as
  long as the instance — admins sign in again after a redeploy/restart.
* Uploads: photos are **base64-in-JSON** (no disk persistence on free plans);
  the backend body limit is 2 MB (`express.json`), so keep images compressed.
* A custom domain later → point it at the Render service, and add the origin to
  `ALLOWED_ORIGINS` (comma-separated) only if a second host is involved.
* Secret rotation: never commit `.env` / `appsettings.json` — they stay local-only;
  production secrets live only in Render's dashboard.
