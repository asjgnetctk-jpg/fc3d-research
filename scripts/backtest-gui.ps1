Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $PSScriptRoot "backtest-easy-runner.ps1"
$pwshPath = (Get-Process -Id $PID).Path
$logicalCores = [Environment]::ProcessorCount
$safeWorkerLimit = [Math]::Min(4, $logicalCores)
$recommendedWorkers = [Math]::Min(2, $safeWorkerLimit)

$form = New-Object System.Windows.Forms.Form
$form.Text = "福彩3D本地公式回测器"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object System.Drawing.Size(520, 390)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = '选择参数后点击“开始回测”'
$title.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 16, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(28, 22)
$form.Controls.Add($title)

$notice = New-Object System.Windows.Forms.Label
$notice.Text = "只使用本机CPU，不调用GPT，不产生API费用。当前用于寻找V9类低命中公式。"
$notice.AutoSize = $true
$notice.ForeColor = [System.Drawing.Color]::FromArgb(65, 79, 74)
$notice.Location = New-Object System.Drawing.Point(30, 66)
$form.Controls.Add($notice)

function Add-Label($text, $x, $y) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.AutoSize = $true
  $label.Location = New-Object System.Drawing.Point($x, $y)
  $form.Controls.Add($label)
}

Add-Label "玩法" 32 118
$sizeBox = New-Object System.Windows.Forms.ComboBox
$sizeBox.DropDownStyle = "DropDownList"
$sizeBox.Items.AddRange(@("5码", "6码", "7码", "8码"))
$sizeBox.SelectedIndex = 2
$sizeBox.Location = New-Object System.Drawing.Point(150, 113)
$sizeBox.Size = New-Object System.Drawing.Size(310, 30)
$form.Controls.Add($sizeBox)

Add-Label "测试公式数量" 32 169
$sampleBox = New-Object System.Windows.Forms.ComboBox
$sampleBox.DropDownStyle = "DropDownList"
$sampleBox.Items.AddRange(@("1万（安全试跑）", "10万（建议）", "100万（较慢）", "500万（很慢）"))
$sampleBox.SelectedIndex = 1
$sampleBox.Location = New-Object System.Drawing.Point(150, 164)
$sampleBox.Size = New-Object System.Drawing.Size(310, 30)
$form.Controls.Add($sampleBox)

Add-Label "CPU线程" 32 220
$workerBox = New-Object System.Windows.Forms.NumericUpDown
$workerBox.Minimum = 1
$workerBox.Maximum = $safeWorkerLimit
$workerBox.Value = $recommendedWorkers
$workerBox.Location = New-Object System.Drawing.Point(150, 215)
$workerBox.Size = New-Object System.Drawing.Size(310, 30)
$form.Controls.Add($workerBox)

$tip = New-Object System.Windows.Forms.Label
$tip.Text = "为防止电脑卡死，程序最多使用4线程。建议先用10万，完成后再逐步增加。"
$tip.AutoSize = $true
$tip.ForeColor = [System.Drawing.Color]::FromArgb(138, 91, 15)
$tip.Location = New-Object System.Drawing.Point(31, 269)
$form.Controls.Add($tip)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = "开始回测"
$startButton.Size = New-Object System.Drawing.Size(205, 48)
$startButton.Location = New-Object System.Drawing.Point(32, 313)
$startButton.BackColor = [System.Drawing.Color]::FromArgb(21, 86, 67)
$startButton.ForeColor = [System.Drawing.Color]::White
$startButton.FlatStyle = "Flat"
$form.Controls.Add($startButton)

$openButton = New-Object System.Windows.Forms.Button
$openButton.Text = "打开结果文件夹"
$openButton.Size = New-Object System.Drawing.Size(205, 48)
$openButton.Location = New-Object System.Drawing.Point(255, 313)
$form.Controls.Add($openButton)

$openButton.Add_Click({
  $workPath = Join-Path $projectRoot "work"
  if (-not (Test-Path $workPath)) {
    New-Item -ItemType Directory -Path $workPath | Out-Null
  }
  Start-Process explorer.exe -ArgumentList $workPath
})

$startButton.Add_Click({
  $sizes = @(5, 6, 7, 8)
  $sampleValues = @(10000, 100000, 1000000, 5000000)
  $selectedSize = $sizes[$sizeBox.SelectedIndex]
  $selectedSamples = $sampleValues[$sampleBox.SelectedIndex]
  $selectedWorkers = [int]$workerBox.Value

  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $runnerPath + '"'),
    "-Size", $selectedSize,
    "-Samples", $selectedSamples,
    "-Workers", $selectedWorkers
  )
  Start-Process $pwshPath -ArgumentList $arguments
  $form.Close()
})

[void]$form.ShowDialog()
