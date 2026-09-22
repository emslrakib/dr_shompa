param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://')]
    [string]$SiteUrl
)

$baseUrl = $SiteUrl.TrimEnd('/')
$healthUrl = "$baseUrl/api/health"

try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 20
    $body = $response.Content | ConvertFrom-Json

    if ($response.StatusCode -ne 200 -or -not $body.success -or $body.database -ne 'connected') {
        throw "Health endpoint returned an unhealthy result: $($response.Content)"
    }

    Write-Host "IIS deployment verification passed." -ForegroundColor Green
    Write-Host "Site: $baseUrl"
    Write-Host "Database: $($body.database)"
    Write-Host "HTTP status: $($response.StatusCode)"
} catch {
    Write-Error "IIS deployment verification failed: $($_.Exception.Message)"
    exit 1
}