@echo off
set "BACKTEST_PWSH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe"
if not exist "%BACKTEST_PWSH%" (
  echo Backtest runtime not found. Please send this screenshot to Codex.
  pause
  exit /b 1
)
"%BACKTEST_PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\v2-high-backtest-gui.ps1"
if errorlevel 1 pause
exit /b
