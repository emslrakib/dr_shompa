# Production delivery guide

## 1. Server requirements

- Node.js 24 LTS or a currently supported Node.js LTS release
- SQL Server reachable over TLS
- A reverse proxy with HTTPS (IIS, Nginx, or a managed host)
- A domain name and a valid TLS certificate

Do **not** expose port `5000` directly to the public internet. Bind the reverse proxy to HTTPS/443 and proxy requests to `http://127.0.0.1:5000`.

## 2. Install and configure

```powershell
cd C:\path\to\DrShompa
npm.cmd ci --omit=dev
Copy-Item .env.example .env
```

Set these production values in `appsettings.json`
(preferred — one file per machine, see `appsettings.example.json`)
or in `.env`:

```dotenv
NODE_ENV=production
PORT=5000
TRUST_PROXY=true
ALLOWED_ORIGINS=https://your-domain.example

DB_SERVER=your-sql-server
DB_NAME=DrShompaDB
DB_USER=least_privilege_app_user
DB_PASSWORD="a-long-unique-password"
DB_PORT=1433
DB_ENCRYPT=true
DB_TRUST_SERVER_CERT=false

ADMIN_USER=admin
ADMIN_PASS="a-long-unique-admin-password"
SESSION_SECRET="replace-with-a-random-48-byte-base64url-secret"

REMINDER_DRY_RUN=true
```

Generate `SESSION_SECRET` with:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The application intentionally refuses to start in production if admin authentication, a strong session secret, encrypted database transport, or certificate validation are missing.

## 3. Database

Run `setup_db.sql` once against the intended production database using a database administrator account. The runtime SQL login should receive only the minimum permissions needed for the application tables; it should not have server administrator privileges.

## 4. Start and verify

```powershell
npm.cmd start
Invoke-WebRequest http://127.0.0.1:5000/api/health -UseBasicParsing
```

Expected health response: HTTP 200 and `{"success":true,"server":"up","database":"connected",...}`.

Then verify over the real HTTPS domain:

- public home page loads;
- `/login` accepts only the configured administrator credentials;
- a booking can be created;
- admin can view and update that booking;
- logout invalidates the session;
- reminder delivery remains dry-run until the actual SMS/SMTP provider is tested.

## 5. Operations checklist

- Run the Node process as a non-administrator Windows service account.
- Use a service manager (for example, NSSM, Windows Service, or your hosting platform) configured to restart the process on failure.
- Back up SQL Server daily and test a restore before launch.
- Restrict SQL Server firewall access to the application host only.
- Store `.env` outside source control and rotate database/admin/SMTP/SMS secrets if access is shared or suspected to be exposed.
- Monitor `/api/health` from a trusted monitoring service; do not expose detailed infrastructure data through it.
- Apply dependency updates on a staging copy first, run `npm.cmd audit --omit=dev`, then deploy during a maintenance window.

## Built-in safeguards

- Admin-only CMS, patient records, reminders and content changes
- Signed, HttpOnly, SameSite session cookie; `Secure` flag in production
- Same-origin request enforcement and optional CORS allowlist
- Login and public booking rate limits
- Request size limits, security response headers and protected source/config files
- SQL parameterized queries, database timeouts, and graceful shutdown