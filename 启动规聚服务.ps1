param(
  [switch]$OpenPage,
  [switch]$AllowOffline
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceUrl = "http://127.0.0.1:3002"
$PackagePath = Join-Path $ProjectRoot "package.json"
$LocalVersion = ([string](Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json).version).Trim()

function Test-Service([string]$Url) {
  try {
    return Invoke-RestMethod "$Url/api/status" -TimeoutSec 3
  } catch {
    return $null
  }
}

$ExistingService = Test-Service $ServiceUrl
if ($ExistingService -and $ExistingService.ok) {
  if ([string]$ExistingService.version -ne $LocalVersion) {
    Write-Error "Service version mismatch on port 3002: running $($ExistingService.version), local $LocalVersion. Stop the old Node service before starting again to keep the frontend and backend aligned."
    exit 2
  }
  Write-Host "Open Plan service is already running: $ServiceUrl (version $($ExistingService.version))" -ForegroundColor Green
  if ($OpenPage) { Start-Process $ServiceUrl }
  exit 0
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "Node.js 22 or newer was not found."
}

if (-not $AllowOffline) {
  try {
    $null = Invoke-WebRequest "https://opencode.ai/zen/go/v1/models" -Method Get -TimeoutSec 8 -UseBasicParsing
    Write-Host "Model network check passed: OpenCode Go is reachable." -ForegroundColor Green
  } catch {
    $Details = $_.Exception.Message
    if ($Details -match "401|403|Unauthorized|Forbidden") {
      Write-Host "Model network check passed: OpenCode Go is reachable (authentication response is expected)." -ForegroundColor Green
    } else {
      Write-Error "Model network is unreachable; startup stopped to prevent repeated Agent connection failures. Details: $Details`nUse -AllowOffline only for offline map/document work."
      exit 2
    }
  }
}

Push-Location $ProjectRoot
try {
  Write-Host "Starting Open Plan service: $ServiceUrl" -ForegroundColor Cyan
  & node.exe server/index.mjs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
