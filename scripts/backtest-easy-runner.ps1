param(
  [ValidateSet(5, 6, 7, 8)]
  [int]$Size = 7,
  [ValidateRange(1000, 1700000000)]
  [int64]$Samples = 1000000,
  [ValidateRange(1, 4)]
  [int]$Workers = 2
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$workPath = Join-Path $projectRoot "work"
if (-not (Test-Path $workPath)) {
  New-Item -ItemType Directory -Path $workPath | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$relativeOutput = "work/manual-pool$Size-$timestamp.json"
$absoluteOutput = Join-Path $projectRoot $relativeOutput

Set-Location $projectRoot
(Get-Process -Id $PID).PriorityClass = "BelowNormal"
Write-Host ""
Write-Host "正在回测 $Size 码，共 $($Samples.ToString('N0')) 套公式，使用 $Workers 个CPU线程。" -ForegroundColor Cyan
Write-Host "运行期间请不要关闭这个窗口。" -ForegroundColor Yellow
Write-Host ""

& npm.cmd run backtest -- --size $Size --samples $Samples --workers $Workers --output $relativeOutput
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0 -and (Test-Path $absoluteOutput)) {
  Write-Host "回测完成，结果已保存：" -ForegroundColor Green
  Write-Host $absoluteOutput -ForegroundColor White
  Start-Process explorer.exe -ArgumentList "/select,`"$absoluteOutput`""
} else {
  Write-Host "回测没有成功，请把这个窗口截图发给我。" -ForegroundColor Red
}

Write-Host ""
Read-Host "按回车键关闭窗口"
