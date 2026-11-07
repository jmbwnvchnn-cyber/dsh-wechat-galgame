@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
set "GAL_STOP_EXIT=%ERRORLEVEL%"
if not "%GAL_STOP_EXIT%"=="0" pause
exit /b %GAL_STOP_EXIT%
