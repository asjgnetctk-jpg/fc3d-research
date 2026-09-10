param(
  [ValidateSet("dan", "pool5", "pool6", "pool7")]
  [string]$Play = "dan",
  [ValidateRange(1, 887)]
  [int]$Batch = 1
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$workPath = Join-Path $projectRoot "work"
if (-not (Test-Path $workPath)) { New-Item -ItemType Directory -Path $workPath | Out-Null }
(Get-Process -Id $PID).PriorityClass = "BelowNormal"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$relativeOutput = "work/v2-high-$Play-batch-$Batch-$timestamp.json"
$absoluteOutput = Join-Path $projectRoot $relativeOutput
Set-Location $projectRoot
$host.UI.RawUI.WindowTitle = "V2高命中回测进行中 - $Play - 第$Batch批"

Write-Host ""
Write-Host "V2高命中回测：$Play，第$Batch批，每批500,000套，2线程。" -ForegroundColor Cyan
Write-Host "运行期间可以正常使用电脑，但不要同时启动第二个回测。" -ForegroundColor Yellow
Write-Host ""
& npm.cmd run backtest:v2-high -- --play $Play --batch $Batch --samples 500000 --workers 2 --output $relativeOutput
$exitCode = $LASTEXITCODE
Write-Host ""
if ($exitCode -eq 0 -and (Test-Path $absoluteOutput)) {
  $host.UI.RawUI.WindowTitle = "V2高命中回测已完成"
  Write-Host "回测完成，结果已保存。请把选中的JSON文件交给我复核。" -ForegroundColor Green
  Start-Process explorer.exe -ArgumentList "/select,`"$absoluteOutput`""
  Add-Type -AssemblyName System.Windows.Forms
  [System.Media.SystemSounds]::Asterisk.Play()
  [void][System.Windows.Forms.MessageBox]::Show(
    "第$Batch批 $Play 回测已经完成。结果文件夹已自动打开。",
    "V2高命中回测完成",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
  )
} else {
  $host.UI.RawUI.WindowTitle = "V2高命中回测失败"
  Write-Host "回测失败，请把本窗口截图发给我。" -ForegroundColor Red
}
Read-Host "按回车键关闭窗口"
