$runtimeDir = Join-Path $PSScriptRoot ".runtime"
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

$outLog = Join-Path $runtimeDir "control-server.out.log"
$errLog = Join-Path $runtimeDir "control-server.err.log"

$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*control-server.js*"
  }

if ($existing) {
  Write-Output "Control server is already running"
  return
}

$process = Start-Process `
  -FilePath "node" `
  -ArgumentList "control-server.js" `
  -WorkingDirectory $PSScriptRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Start-Sleep -Seconds 2
Write-Output "Control server started. PID: $($process.Id)"
