$ErrorActionPreference = "Stop"

$DashboardRoot = $PSScriptRoot
$ControlStartScript = Join-Path $DashboardRoot "start-control-server.ps1"
$DashboardPage = Join-Path $DashboardRoot "index.html"
$HealthUrl = "http://127.0.0.1:4321/health"

& $ControlStartScript | Out-Null

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing $HealthUrl -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    throw "Dashboard control server failed to start: $HealthUrl"
}

Start-Process $DashboardPage | Out-Null
