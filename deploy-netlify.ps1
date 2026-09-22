# Deploy dist/ to Netlify via REST API (no CLI needed).
# Usage:  .\deploy-netlify.ps1 -Token 'eyJ...' [-SiteName 'drshompa'] [-Dir 'dist']
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$SiteName = 'drshompa',
  [string]$Dir = 'dist'
)
$ErrorActionPreference = 'Stop'
$api = 'https://api.netlify.com/api/v1'
$h = @{ Authorization = "Bearer $Token"; 'User-Agent' = 'drshompa-deploy' }

function Invoke-Netlify([string]$Method, [string]$Path, $Body, [string]$ContentType) {
  $p = @{ Uri = $api + $Path; Method = $Method; Headers = $h; TimeoutSec = 120 }
  if ($null -ne $Body) { $p.Body = $Body }
  if ($ContentType) { $p.ContentType = $ContentType }
  return Invoke-RestMethod @p
}

# --- 1. Create the site (retry with suffix if the name is taken globally) ---
$site = $null
$names = @($SiteName) + (1..5 | ForEach-Object { "$SiteName-$($_ + 10)" })
foreach ($n in $names) {
  try {
    $site = Invoke-Netlify POST '/sites' (@{ name = $n })
    Write-Host ("SITE_CREATED: " + $n + " -> " + $site.ssl_url)
    break
  } catch {
    $code = 0; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    Write-Host ("name '" + $n + "' failed HTTP " + $code + " -> trying next")
  }
}
if (-not $site) { throw 'could not create site with any candidate name' }

# --- 2. Zip the whitelist build and upload it as one deploy -------------------
$files = Get-ChildItem $Dir -File
if ($files.Count -lt 4) { throw "Dir '$Dir' looks incomplete ($($files.Count) files)" }
$zipPath = Join-Path ([IO.Path]::GetTempPath()) 'drshompa-dist.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
foreach ($f in $files) { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $f.Name) | Out-Null }
$zip.Dispose()
Write-Host ("ZIP: " + (Get-Item $zipPath).Length + " bytes, " + $files.Count + " files")

$bytes = [IO.File]::ReadAllBytes($zipPath)
$deploy = Invoke-Netlify POST ("/sites/" + $site.id + "/deploys") $bytes 'application/zip'
Write-Host ("DEPLOY_ID: " + $deploy.id + " state=" + $deploy.state)
Write-Host ("LIVE_URL:  " + $deploy.ssl_url)
Write-Host ("ADMIN_URL: " + $deploy.admin_url)

# --- 3. Report what Render must allow ----------------------------------------
Write-Host ("ACTION_NEEDED: set Render ALLOWED_ORIGINS=" + $site.ssl_url + " (during Blueprint creation)")
