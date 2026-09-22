# DrShompa — Netlify + Render Deployment Guide

> Referenced by `config.js` (the old SQL Server block was removed when the project
> moved to free hosting). This is the current architecture.

## Architecture

```
Browser (one origin)
   │
   │  https://<SITE>.netlify.app            ← static frontend (this repo, dist/)
   │  ├── /                      → dr-arefin-zannat-sompa.html
   │  ├── /admin                 → admin.html        (UI shell; data is API-only)
   │  ├── /login                 → login.html
   │  ├── /voices | /patient-voices → patient-voices.html
   │  └── /api/*                 → PROXY → https://dr-shompa-backend.onrender.com/api/:splat
   │
   └── Render Web Service (Express API: server.js + db.js + Render Postgres)
```

* Netlify never runs Node — the build is a **whitelist copy**: only the 4 public
  HTML pages + images enter `dist/`. `server.js`, `db.js`, `config.js`, `.env`,
  `appsettings.json`, `package.json` and `*.sql` are never published.
* The browser only ever talks to the Netlify origin, so there are **no CORS
  issues** and session cookies stay first-party.
* Redirects/headers live in **three redundant places** so any deploy method works:
  `netlify.toml` (Git builds), plus `_redirects` / `_headers` copied into `dist/`
  (CLI / API direct deploys).

## Netlify (frontend)

* Config: `netlify.toml`, `_redirects`, `_headers`
* Local publish dir: `dist/`
* Build command (also run by Netlify on Git push):

```bash
rm -rf dist && mkdir -p dist && cp dr-arefin-zannat-sompa.html admin.html login.html patient-voices.html dist/ && cp *.jpg *.jpeg *.png dist/ && cp _redirects _headers dist/
```

## Render (backend) — `render.yaml` Blueprint

Service `dr-shompa-backend`, Node, free plan, `npm ci --omit=dev` → `node server.js`.

| Env var | Source | Why |
|---|---|---|
| `NODE_ENV=production` | fixed | strict cookie/CSP/session mode |
| `DATABASE_URL` | Render Postgres (auto) | `db.js` reads it; SSL via `DB_SSL` |
| `DB_SSL=true` | fixed | Render Postgres requires TLS |
| `TRUST_PROXY=true` | fixed | Express must trust `X-Forwarded-*` behind the Netlify proxy |
| `ALLOWED_ORIGINS` | `https://<SITE>.netlify.app` | `requireSameOrigin` must accept the Netlify origin on state-changing `/api` calls |
| `ADMIN_USER` | `admin` | CMS login |
| `ADMIN_PASS` | `sync: false` — set in Render dashboard | never commit a password |
| `SESSION_SECRET` | `generateValue: true` | auto |

Database `drshompa-db` is provisioned by the same Blueprint; `setup_db.sql` runs
automatically on first boot (db.js creates every table — idempotent, safe to re-run).

## Deploy steps (one-time)

1. **GitHub repo** → push this repo (`main`).
2. **Render** → New + → Blueprint → connect the repo → `render.yaml` is detected →
   Create → set `ADMIN_PASS` in Environment → wait for `/api/health` to answer.
3. **Netlify** → create site → set `ALLOWED_ORIGINS` on the Render service to the
   final site URL → deploy `dist/` (Git-connected build or `netlify deploy --dir=dist`).

## Verify after every deploy

1. `https://<SITE>.netlify.app/dr-arefin-zannat-sompa.html` → home page.
2. `https://<SITE>.netlify.app/api/health` → `{"ok":true,...}` — proves the proxy path.
3. `/login` → CMS password → should reach `/admin` stats (proves Origin/session path).
4. Home page appointment form → submit → success toast (proves POST through proxy).

## Operational notes

* Render free plan **spins down** after inactivity: first request after idle takes
  ~30–50 s (Netlify proxy timeout is 100 s — within budget).
* Sessions are in-memory (Express + UUID cookie) and live as long as the Render
  instance — admins re-login after a redeploy/restart.
* Uploads: photos are **base64-in-JSON** (no disk persistence on free plans);
  backend body limit is 2 MB (`express.json`), so keep images compressed.
* Custom domain later → add it to `ALLOWED_ORIGINS` (comma-separated) on Render.
* Secret rotation: never commit `.env` / `appsettings.json` — they stay local-only;
  production secrets live only in Render's dashboard.
