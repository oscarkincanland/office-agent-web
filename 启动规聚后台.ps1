param(
  [switch]$OpenPage,
  [switch]$StrictNetwork
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceUrl = "http://127.0.0.1:3002"
$serviceCandidate = Get-ChildItem -LiteralPath $ProjectRoot -Filter "*.ps1" -File |
  Where-Object { $_.FullName -ne $MyInvocation.MyCommand.Path -and (Get-Content -LiteralPath $_.FullName -Raw) -match "node\.exe server/index\.mjs" } |
  Select-Object -First 1
if (-not $serviceCandidate) { throw "Open Plan foreground service script was not found." }
$ServiceScript = $serviceCandidate.FullName

function Test-Service {
  try { return Invoke-RestMethod "$ServiceUrl/api/status" -TimeoutSec 3 }
  catch { return $null }
}

$existing = Test-Service
if ($existing -and $existing.ok) {
  Write-Host "Open Plan service is already running: $ServiceUrl" -ForegroundColor Green
  if ($OpenPage) { Start-Process $ServiceUrl }
  exit 0
}

# Keep the supervisor in an independent hidden PowerShell process.
$arguments = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", $ServiceScript,
  "-AllowOffline"
)
if ($StrictNetwork) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $ServiceScript,
    "-StrictNetwork"
  )
}

$supervisor = Start-Process `
  -FilePath "powershell.exe" `
  -WindowStyle Hidden `
  -WorkingDirectory $ProjectRoot `
  -ArgumentList $arguments `
  -PassThru

$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Seconds 1
  $running = Test-Service
  if ($running -and $running.ok) {
    Write-Host "Open Plan service started in background: $ServiceUrl" -ForegroundColor Green
    if ($OpenPage) { Start-Process $ServiceUrl }
    exit 0
  }
} while ((Get-Date) -lt $deadline)

if ($supervisor.HasExited) {
  throw "Background service failed to start. Use the foreground launcher to inspect logs."
}
throw "Background service startup timed out: $ServiceUrl"
