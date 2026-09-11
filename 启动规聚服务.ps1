param(
  [switch]$OpenPage,
  [switch]$AllowOffline,
  [switch]$StrictNetwork
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceUrl = "http://127.0.0.1:3002"
$PackagePath = Join-Path $ProjectRoot "package.json"
$LocalVersion = ([string](Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json).version).Trim()
$LogDirectoryName = -join ([char[]]@(0x8FD0, 0x884C, 0x65E5, 0x5FD7))
$LogFileName = (-join ([char[]]@(0x670D, 0x52A1, 0x76D1, 0x7763))) + ".log"
$SupervisorLog = Join-Path (Join-Path $ProjectRoot $LogDirectoryName) $LogFileName
$RestartDelaySeconds = 3
$MaxRapidRestarts = 5

New-Item -ItemType Directory -Path (Split-Path -Parent $SupervisorLog) -Force | Out-Null
function Write-SupervisorLog([string]$Message) {
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  Add-Content -LiteralPath $SupervisorLog -Value $line -Encoding UTF8
  Write-Host $line
}

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
    } elseif ($StrictNetwork) {
      Write-Error "Model network is unreachable; strict startup check stopped the service. Details: $Details`nRemove -StrictNetwork to start the local UI and let Agent requests retry at runtime."
      exit 2
    } else {
      Write-Warning "Model network check failed; the local UI will still start. Agent requests will report and retry the provider failure at runtime. Details: $Details"
    }
  }
}

Push-Location $ProjectRoot
try {
  $rapidRestarts = 0
  while ($true) {
    $listening = @()
    $listening = @(Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue)
    if ($listening.Count -gt 0) {
      Write-SupervisorLog "Port 3002 is already occupied. Supervisor stopped to avoid duplicate services."
      exit 3
    }
    $startAt = Get-Date
    Write-SupervisorLog "Starting Open Plan service at $ServiceUrl (version $LocalVersion)."
    & node.exe server/index.mjs
    $exitCode = $LASTEXITCODE

    if ($exitCode -eq 0) {
      Write-SupervisorLog "Service stopped normally (exit code $exitCode)."
      break
    }

    $endedAt = Get-Date
    if (($endedAt - $startAt).TotalSeconds -lt 30) { $rapidRestarts++ } else { $rapidRestarts = 0 }
    if ($rapidRestarts -ge $MaxRapidRestarts) {
      Write-SupervisorLog "Service exited rapidly $rapidRestarts times. Retrying after 30 seconds."
      Start-Sleep -Seconds 30
      $rapidRestarts = 0
    } else {
      Write-SupervisorLog "Service exited unexpectedly (exit code $exitCode). Restarting after $RestartDelaySeconds seconds."
      Start-Sleep -Seconds $RestartDelaySeconds
    }
  }
} finally {
  Pop-Location
}
