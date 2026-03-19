$existing = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*control-server.js*"
  }

if (-not $existing) {
  Write-Output "Control server is not running"
  return
}

$existing | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}

Write-Output "Control server stopped"
