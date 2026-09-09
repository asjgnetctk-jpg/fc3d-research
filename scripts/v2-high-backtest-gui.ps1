Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$runnerPath = Join-Path $PSScriptRoot "v2-high-backtest-runner.ps1"
$pwshPath = (Get-Process -Id $PID).Path
$form = New-Object System.Windows.Forms.Form
$form.Text = "V2高命中率回测器"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object System.Drawing.Size(520, 370)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)

$title = New-Object System.Windows.Forms.Label
$title.Text = "每批固定测试50万套公式"
$title.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 16, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(30, 24)
$form.Controls.Add($title)

$notice = New-Object System.Windows.Forms.Label
$notice.Text = "最多2线程、低优先级运行。批次编号不同，测试的公式不会重复。"
$notice.AutoSize = $true
$notice.ForeColor = [System.Drawing.Color]::FromArgb(64, 78, 74)
$notice.Location = New-Object System.Drawing.Point(32, 68)
$form.Controls.Add($notice)

$playLabel = New-Object System.Windows.Forms.Label
$playLabel.Text = "选择玩法"
$playLabel.AutoSize = $true
$playLabel.Location = New-Object System.Drawing.Point(34, 127)
$form.Controls.Add($playLabel)

$playBox = New-Object System.Windows.Forms.ComboBox
$playBox.DropDownStyle = "DropDownList"
$playBox.Items.AddRange(@("独胆", "5码", "6码", "7码"))
$playBox.SelectedIndex = 0
$playBox.Location = New-Object System.Drawing.Point(150, 121)
$playBox.Size = New-Object System.Drawing.Size(310, 30)
$form.Controls.Add($playBox)

$batchLabel = New-Object System.Windows.Forms.Label
$batchLabel.Text = "批次编号"
$batchLabel.AutoSize = $true
$batchLabel.Location = New-Object System.Drawing.Point(34, 184)
$form.Controls.Add($batchLabel)

$batchBox = New-Object System.Windows.Forms.NumericUpDown
$batchBox.Minimum = 1
$batchBox.Maximum = 1000
$batchBox.Value = 1
$batchBox.Location = New-Object System.Drawing.Point(150, 178)
$batchBox.Size = New-Object System.Drawing.Size(310, 30)
$form.Controls.Add($batchBox)

$tip = New-Object System.Windows.Forms.Label
$tip.Text = "第一次用第1批；下次同一玩法改成第2批。运行可能需要十几分钟。"
$tip.AutoSize = $true
$tip.ForeColor = [System.Drawing.Color]::FromArgb(145, 89, 10)
$tip.Location = New-Object System.Drawing.Point(33, 239)
$form.Controls.Add($tip)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = "开始50万回测"
$startButton.Size = New-Object System.Drawing.Size(205, 50)
$startButton.Location = New-Object System.Drawing.Point(32, 292)
$startButton.BackColor = [System.Drawing.Color]::FromArgb(17, 82, 64)
$startButton.ForeColor = [System.Drawing.Color]::White
$startButton.FlatStyle = "Flat"
$form.Controls.Add($startButton)

$folderButton = New-Object System.Windows.Forms.Button
$folderButton.Text = "打开结果文件夹"
$folderButton.Size = New-Object System.Drawing.Size(205, 50)
$folderButton.Location = New-Object System.Drawing.Point(255, 292)
$form.Controls.Add($folderButton)

$folderButton.Add_Click({ Start-Process explorer.exe (Join-Path (Split-Path -Parent $PSScriptRoot) "work") })
$startButton.Add_Click({
  $plays = @("dan", "pool5", "pool6", "pool7")
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", ('"' + $runnerPath + '"'),
    "-Play", $plays[$playBox.SelectedIndex],
    "-Batch", [int]$batchBox.Value
  )
  Start-Process $pwshPath -ArgumentList $arguments
  $form.Close()
})

[void]$form.ShowDialog()
