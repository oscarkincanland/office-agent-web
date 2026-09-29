# 停止规聚服务（连同后台监督脚本）
#
# 背景：启动规聚服务.ps1 是一个监督循环——Node 服务只要以非 0 退出码结束，
# 3 秒后就会被自动拉起。所以直接结束 node 进程会立刻被重启，看起来“关不掉”。
# 正确顺序是：先停监督进程，再停 node 服务，最后确认 3002 端口已释放。

param(
  [switch]$Quiet
)

$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
# 只匹配监督脚本的文件名（带 .ps1），避免误杀命令行里恰好“提到”这几个字的进程
# （例如在终端里 grep/过滤这些关键字时，该终端自身也会被匹配到）。
$SupervisorPattern = "启动规聚服务.ps1"
$SelfMarker = "停止规聚服务"
$SelfId = $PID

function Write-Line([string]$Text, [string]$Color = "Gray") {
  if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color }
}

Write-Line "正在停止规聚服务 ..."

# 1) 先停监督进程：否则下面的 Node 会被它自动拉起
$supervisors = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$SupervisorPattern*" -and $_.CommandLine -notlike "*$SelfMarker*" -and $_.ProcessId -ne $SelfId })
foreach ($p in $supervisors) {
  Write-Line ("  结束监督进程 PID {0}" -f $p.ProcessId) "DarkGray"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# 2) 再停 Node 服务（命令行为 "node ... server/index.mjs"）
$nodeProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*server/index.mjs*" })
foreach ($p in $nodeProcs) {
  Write-Line ("  结束服务进程 PID {0}" -f $p.ProcessId) "DarkGray"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# 3) 等待端口释放（进程退出是异步的）
$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  $listen = @(Get-NetTCPConnection -LocalPort 3002 -State Listen -ErrorAction SilentlyContinue)
} while ($listen.Count -gt 0 -and (Get-Date) -lt $deadline)

if ($listen.Count -gt 0) {
  Write-Line ("停止未完成：3002 端口仍被 PID {0} 占用，请检查是否有其它进程在运行规聚服务。" -f $listen[0].OwningProcess) "Red"
  exit 1
}

Write-Line "规聚服务已停止，3002 端口已释放。" "Green"
exit 0
