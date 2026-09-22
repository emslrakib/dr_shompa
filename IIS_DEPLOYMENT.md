# IIS deployment guide (Windows + Node.js)

This application is a Node.js/Express service. IIS serves as the HTTPS reverse proxy; it does not run `server.js` itself.

## 1. Required server software

Install on the Windows server:

1. IIS with **Web Server** role enabled.
2. IIS **URL Rewrite 2.x** module.
3. IIS **Application Request Routing (ARR)** module.
4. Node.js 24 LTS (or another supported Node.js LTS release).
5. SQL Server connectivity from the IIS/Node server.

In IIS Manager, select the server node, open **Application Request Routing Cache**, select **Server Proxy Settings**, then enable **Proxy**.

## 2. Prepare the application folder

Copy this folder to a non-public application location, for example:

```text
C:\Sites\DrShompa
```

From that folder run:

```powershell
npm.cmd ci --omit=dev
npm.cmd run db:migrate
Copy-Item .env.example .env
```

Configure the app before the first production start.

Use `appsettings.json` (one file per machine — it beats conflicting `.env`
values; see `appsettings.example.json`), **or** `.env` below:

```dotenv
NODE_ENV=production
PORT=5000
TRUST_PROXY=true
ALLOWED_ORIGINS=https://your-domain.example

DB_SERVER=your-sql-server
DB_NAME=DrShompaDB
DB_USER=least_privilege_app_user
DB_PASSWORD="your-password"
DB_PORT=1433
DB_ENCRYPT=true
DB_TRUST_SERVER_CERT=false

ADMIN_USER=your_admin_user
ADMIN_PASS="long-unique-password"
SESSION_SECRET="random-secret-at-least-32-characters"
REMINDER_DRY_RUN=true
```

Never put `.env` inside a public IIS folder, source-control repository, or shared download location.

## 3. Create the IIS site

1. Open **IIS Manager** as Administrator.
2. Create a new site, for example `DrShompa`.
3. Set its physical path to the application folder, for example `C:\Sites\DrShompa`.
4. Add an **HTTPS** binding on port `443`, assign the real domain and its valid certificate.
5. Keep `web.config` in the application root. It proxies all requests to `http://127.0.0.1:5000`.
6. Do not expose TCP port `5000` through the Windows Firewall or router. Only IIS needs public HTTPS access.

## 4. Run Node.js reliably

Use a Windows Service manager such as NSSM, Task Scheduler at startup, or your managed hosting provider. The service must run:

```text
C:\Sites\DrShompa\start-production.cmd
```

Set the service to restart on failure and run under a dedicated, non-administrator Windows account with read/write access only where needed.

For a manual production start during setup:

```powershell
cd C:\Sites\DrShompa
.\start-production.cmd
```

The app intentionally refuses to start in production if secure database TLS, admin authentication, or `SESSION_SECRET` is missing.

## 5. Verify after deployment

From the server:

```powershell
.\verify-iis.ps1 -SiteUrl "https://your-domain.example"
```

Also check manually:

- `https://your-domain.example/`
- `https://your-domain.example/login`
- `https://your-domain.example/admin`
- `https://your-domain.example/api/health`

## Troubleshooting

| Symptom | Check |
|---|---|
| IIS 500.19 | URL Rewrite is missing, `web.config` is malformed, or IIS app pool cannot read the folder. |
| IIS 502.3 | Node process is not running, wrong `PORT`, or ARR proxy is disabled. Test `http://127.0.0.1:5000/api/health` on the server. |
| Login cookie is not retained | Use HTTPS, `TRUST_PROXY=true`, and ensure IIS forwards the request through this `web.config`. |
| Production startup fails | Read the console output and correct the exact missing secure `.env` setting. |
| Site points to wrong backend | Confirm `web.config` points to `127.0.0.1:5000` and `.env` has `PORT=5000`. |