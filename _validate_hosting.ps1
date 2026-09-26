# Local pre-flight check for the Render deployment (Render-only topology).
#
# Proves that the single Express process really serves the whole product:
# public site, CMS, login screen and API - which is what the Blueprint in
# render.yaml deploys. Run it before pushing:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\_validate_hosting.ps1
#
# Exit code 0 = every check passed.

param(
  [string]$DatabaseUrl = '',   # optional: a real Render/Neon URL to prove the DB path
  [int]$Port = 5061,
  [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:failures = 0
$script:skips = 0

function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { Write-Output ("PASS  " + $Name + "  - " + $Detail) }
  else { Write-Output ("FAIL  " + $Name + "  - " + $Detail); $script:failures++ }
}

function Skip([string]$Name, [string]$Detail) {
  Write-Output ("SKIP  " + $Name + "  - " + $Detail); $script:skips++
}

# --- 1. render.yaml: valid Blueprint, safe production settings ---------------
$blueprint = Get-Content (Join-Path $root 'render.yaml') -Raw

Check 'Postgres is a top-level databases: entry' `
  ([regex]::IsMatch($blueprint, '(?m)^databases:')) 'Render requires datastores outside the services: list'
Check 'DATABASE_URL is handed to the service by fromDatabase' `
  ([regex]::IsMatch($blueprint, '(?ms)key:\s*DATABASE_URL\s*\r?\n\s*fromDatabase:\s*\r?\n\s*name:\s*drshompa-db')) 'DATABASE_URL <- connectionString'
Check 'NODE_ENV=production is set' `
  ([regex]::IsMatch($blueprint, '(?ms)key:\s*NODE_ENV\s*\r?\n\s*value:\s*production')) 'the production guard requires it'
Check 'DB_SSL=true is set' `
  ([regex]::IsMatch($blueprint, '(?ms)key:\s*DB_SSL\s*\r?\n\s*value:\s*"?true"?')) 'TLS to Render Postgres'
Check 'TRUST_PROXY=true is set' `
  ([regex]::IsMatch($blueprint, '(?ms)key:\s*TRUST_PROXY\s*\r?\n\s*value:\s*"?true"?')) 'Render terminates TLS'
Check 'SESSION_SECRET is generated, never committed' `
  ([regex]::IsMatch($blueprint, '(?ms)key:\s*SESSION_SECRET\s*\r?\n\s*generateValue:\s*true')) 'generateValue: true'
Check 'ADMIN_PASS is prompted for, never committed' `
  ([regex]::IsMatch($blueprint, '(?ms)key:\s*ADMIN_PASS\s*\r?\n\s*sync:\s*false')) 'sync: false'
Check 'no secret is hardcoded in the Blueprint' `
  (-not [regex]::IsMatch($blueprint, '(?ms)key:\s*(ADMIN_PASS|SESSION_SECRET|PGPASSWORD)\s*\r?\n\s*value:\s*\S')) 'no value: line next to a secret'
Check 'healthCheckPath is set' `
  ([regex]::IsMatch($blueprint, '(?m)^\s*healthCheckPath:\s*/\S+')) '/api/health'

$supported = @('oregon', 'ohio', 'virginia', 'frankfurt', 'singapore')
$regions = @([regex]::Matches($blueprint, '(?m)^\s*region:\s*([a-z]+)') | ForEach-Object { $_.Groups[1].Value })
$badRegions = @($regions | Where-Object { $supported -notcontains $_ })
Check 'every region really exists on Render' ($regions.Count -gt 0 -and $badRegions.Count -eq 0) ("regions: " + ($regions -join ', '))

# --- 2. Boot the app exactly the way Render will ------------------------------
# Render injects this environment. DATABASE_URL points at a closed port unless
# -DatabaseUrl is supplied, which proves the production guard and the same-origin
# routing without needing a live database.
function Start-App([hashtable]$Settings, [string]$LogPrefix) {
  # Keys the app reads for this deployment. Absent ones are REMOVED from the
  # environment so a negative test really starts without them.
  foreach ($key in @('NODE_ENV', 'ADMIN_USER', 'ADMIN_PASS', 'SESSION_SECRET',
                     'DB_SSL', 'TRUST_PROXY', 'DB_AUTO_MIGRATE', 'PORT', 'DATABASE_URL')) {
    if ($Settings.ContainsKey($key)) { Set-Item -Path ("Env:" + $key) -Value ([string]$Settings[$key]) }
    else { Remove-Item -Path ("Env:" + $key) -ErrorAction SilentlyContinue }
  }
  return Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $root -PassThru `
    -RedirectStandardOutput (Join-Path $root ($LogPrefix + '_stdout.log')) `
    -RedirectStandardError (Join-Path $root ($LogPrefix + '_stderr.log')) -WindowStyle Hidden
}

function Stop-App($Proc) {
  if ($Proc -and -not $Proc.HasExited) {
    Stop-Process -Id $Proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
}

$production = @{
  NODE_ENV        = 'production'
  ADMIN_USER      = 'admin'
  ADMIN_PASS      = 'preflight-only-password'
  SESSION_SECRET  = 'drshompa-preflight-' + ('x' * 40)
  DB_SSL          = 'true'
  TRUST_PROXY     = 'true'
  DB_AUTO_MIGRATE = 'false'
  PORT            = "$Port"
  DATABASE_URL    = 'postgres://preflight:preflight@127.0.0.1:59999/drshompa?sslmode=require'
}
if ($DatabaseUrl) {
  $production.DATABASE_URL = $DatabaseUrl
  $production.DB_AUTO_MIGRATE = 'true'
}

$process = Start-App $production '_hostcheck'

$base = "http://127.0.0.1:$Port"
try {
  $ready = $false
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  # "/login" answers without touching the database, so it is the safe readiness
  # probe for a host whose datastore may still be waking up.
  while ((Get-Date) -lt $deadline -and -not $ready) {
    if ($process.HasExited) { break }
    try { $null = Invoke-WebRequest "$base/login" -UseBasicParsing -TimeoutSec 5; $ready = $true }
    catch { Start-Sleep -Milliseconds 700 }
  }

  Check 'NODE_ENV=production boots (the production guard passes)' $ready "node server.js (pid $($process.Id))"
  if (-not $ready) {
    Write-Output '--- server stdout ---'; Get-Content (Join-Path $root '_hostcheck_stdout.log') -ErrorAction SilentlyContinue | Select-Object -Last 20
    Write-Output '--- server stderr ---'; Get-Content (Join-Path $root '_hostcheck_stderr.log') -ErrorAction SilentlyContinue | Select-Object -Last 20
    throw 'the server never started in production mode'
  }

  # --- 3. Same-origin routing: every page and the API from one origin --------
  $pages = [ordered]@{
    '/'               = @{ Marker = 'Consultant Psychiatrist, Sylhet'; Accept = 'text/html' }
    '/login'          = @{ Marker = 'Sign in';                        Accept = 'text/html' }
    '/voices'         = @{ Marker = 'Patient voices';                 Accept = 'text/html' }
    '/patient-voices' = @{ Marker = 'Patient voices';                 Accept = 'text/html' }
  }
  foreach ($route in $pages.Keys) {
    $spec = $pages[$route]
    try {
      $page = Invoke-WebRequest "$base$route" -UseBasicParsing -TimeoutSec 20 -Headers @{ Accept = $spec.Accept }
      Check "page $route" ($page.StatusCode -eq 200 -and $page.Content.Contains($spec.Marker)) `
        "HTTP $($page.StatusCode), $($page.RawContentLength) bytes"
    } catch {
      Check "page $route" $false $_.Exception.Message
    }
  }

  # "/admin" is guarded: a browser must be sent to the sign-in screen instead of
  # receiving the control panel, and a script must be refused outright.
  try {
    $adminPage = Invoke-WebRequest "$base/admin" -UseBasicParsing -TimeoutSec 20 -Headers @{ Accept = 'text/html' }
    $landedOn = [string]$adminPage.BaseResponse.ResponseUri
    Check 'page /admin sends a browser to the sign-in screen' `
      ($adminPage.StatusCode -eq 200 -and $landedOn -match '/login' -and $adminPage.Content.Contains('Sign in')) `
      "landed on $landedOn"
  } catch { Check 'page /admin sends a browser to the sign-in screen' $false $_.Exception.Message }

  try {
    $null = Invoke-WebRequest "$base/admin" -UseBasicParsing -TimeoutSec 20 -Headers @{ Accept = 'application/json' }
    Check 'page /admin refuses a JSON client' $false 'the request was let through'
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    Check 'page /admin refuses a JSON client' ($code -eq 401) "HTTP $code"
  }

  try {
    $session = Invoke-RestMethod "$base/api/session" -TimeoutSec 20
    Check 'admin sign-in is on (ADMIN_USER + ADMIN_PASS arrive)' ($session.authEnabled -eq $true) "authEnabled=$($session.authEnabled)"
  } catch { Check 'admin sign-in is on' $false $_.Exception.Message }

  # --- 4. The database path --------------------------------------------------
  if ($DatabaseUrl) {
    try {
      $health = Invoke-RestMethod "$base/api/health" -TimeoutSec 60
      Check '/api/health reports a connected database' ($health.database -eq 'connected') "database=$($health.database)"
    } catch { Check '/api/health reports a connected database' $false $_.Exception.Message }

    try {
      $content = Invoke-RestMethod "$base/api/cms/content" -TimeoutSec 30
      Check 'CMS content API returns data' ([bool]$content.success) "success=$($content.success)"
    } catch { Check 'CMS content API returns data' $false $_.Exception.Message }
  } else {
    Skip 'database checks' 'no -DatabaseUrl given - pass the Render/Neon URL to prove the live data path'
  }
} finally {
  Stop-App $process
}

# --- 5. The production guard must still stop a misconfigured host -------------
# That is why render.yaml keeps `generateValue: true` for SESSION_SECRET. A local
# .env always supplies a secret, so the "missing" branch cannot be exercised on a
# developer machine; the strength branch below proves the very same guard is live.
$unsafe = $production.Clone()
$unsafe.SESSION_SECRET = 'too-short'
$guard = Start-App $unsafe '_hostcheck_guard'
$guardExited = $guard.WaitForExit(20000)
if (-not $guardExited) { Stop-App $guard }
$guardError = Get-Content (Join-Path $root '_hostcheck_guard_stderr.log') -Raw -ErrorAction SilentlyContinue
Check 'a weak SESSION_SECRET aborts the boot' `
  ($guardExited -and -not [string]::IsNullOrWhiteSpace($guardError) -and $guardError.Contains('SESSION_SECRET')) `
  "exited=$guardExited, the message names SESSION_SECRET"

Write-Output ''
if ($script:failures -eq 0) {
  $note = ''
  if ($script:skips -gt 0) { $note = " ($script:skips skipped)" }
  Write-Output ('HOSTING PRE-FLIGHT: all checks passed.' + $note)
  exit 0
}
Write-Output ('HOSTING PRE-FLIGHT: ' + $script:failures + ' check(s) failed.')
exit 1
