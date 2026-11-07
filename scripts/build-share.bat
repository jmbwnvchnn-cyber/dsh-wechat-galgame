@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-share.ps1"
if errorlevel 1 exit /b %errorlevel%
