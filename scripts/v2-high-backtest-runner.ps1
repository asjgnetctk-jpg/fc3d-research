param(
  [ValidateSet("dan", "pool5", "pool6", "pool7")]
  [string]$Play = "dan",
  [ValidateRange(1, 88)]
  [int]$Batch = 1,
  [ValidateRange(1, 88)]
  [int]$BatchCount = 1,
  [ValidateRange(1, 5000000)]
  [int]$Samples = 5000000,
  [ValidateRange(1, 4)]
  [int]$Workers = 4,
  [switch]$NonInteractive
)

$createdNew = $false
$singleRunMutex = New-Object System.Threading.Mutex($true, "Local\Fc3dV2HighBacktest", [ref]$createdNew)
if (-not $createdNew) {
  Write-Host "已有一个回测正在运行，本次没有重复启动。" -ForegroundColor Yellow
  Read-Host "按回车键关闭窗口"
  exit 2
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$workPath = Join-Path $projectRoot "work"
if (-not (Test-Path $workPath)) { New-Item -ItemType Directory -Path $workPath | Out-Null }
(Get-Process -Id $PID).PriorityClass = "BelowNormal"
Set-Location $projectRoot
$lastBatch = [Math]::Min(88, $Batch + $BatchCount - 1)
$completed = 0
$lastOutput = $null
$failedBatch = $null

Write-Host ""
Write-Host "V2自适应连续回测：$Play，第${Batch}批到第${lastBatch}批。" -ForegroundColor Cyan
Write-Host "每批$($Samples.ToString('N0'))次候选评估、${Workers}线程；一批完成后自动开始下一批。" -ForegroundColor Cyan
Write-Host "运行期间可以正常使用电脑，但不要同时启动第二个回测。" -ForegroundColor Yellow

for ($currentBatch = $Batch; $currentBatch -le $lastBatch; $currentBatch++) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $relativeOutput = "work/v2-adaptive5m-$Play-batch-$currentBatch-$timestamp.json"
  $absoluteOutput = Join-Path $projectRoot $relativeOutput
  $host.UI.RawUI.WindowTitle = "V2连续回测 - $Play - 第$currentBatch/$lastBatch批"
  Write-Host ""
  Write-Host "========== 开始第${currentBatch}批（计划到第${lastBatch}批） ==========" -ForegroundColor Cyan
  & npm.cmd run backtest:v2-adaptive -- --play $Play --batch $currentBatch --samples $Samples --workers $Workers --output $relativeOutput
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -or -not (Test-Path $absoluteOutput)) {
    $failedBatch = $currentBatch
    Write-Host "第${currentBatch}批失败，连续任务已经停止；此前结果均已保留。" -ForegroundColor Red
    break
  }
  $completed += 1
  $lastOutput = $absoluteOutput
  $batchReport = Get-Content -LiteralPath $absoluteOutput -Raw | ConvertFrom-Json
  $trainingRate = [Math]::Round($batchReport.selected.training.rate * 100, 2)
  $promotionText = if ($batchReport.selected.promotionEligible) { "达到晋级线" } else { "未达到晋级线" }
  $nextText = if ($currentBatch -lt $lastBatch) { "即将继续下一批" } else { "连续计划已完成" }
  Write-Host "第${currentBatch}批完成：训练命中率${trainingRate}%，$promotionText。$nextText。" -ForegroundColor Green
}

if ($NonInteractive) {
  if ($failedBatch) { exit 1 }
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
if ($failedBatch) {
  $host.UI.RawUI.WindowTitle = "V2连续回测已停止"
  [System.Media.SystemSounds]::Hand.Play()
  [void][System.Windows.Forms.MessageBox]::Show(
    "已完成${completed}批，第${failedBatch}批失败并停止。此前结果已经保存。",
    "V2连续回测已停止",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
} elseif ($lastOutput) {
  $host.UI.RawUI.WindowTitle = "V2连续回测已完成"
  Start-Process explorer.exe -ArgumentList "/select,`"$lastOutput`""
  [System.Media.SystemSounds]::Asterisk.Play()
  [void][System.Windows.Forms.MessageBox]::Show(
    "连续回测完成：共${completed}批（第${Batch}批到第${lastBatch}批）。结果文件夹已打开。",
    "V2连续回测完成",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
}
Read-Host "按回车键关闭窗口"
