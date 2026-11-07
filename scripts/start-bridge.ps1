$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$localPython = Join-Path (Get-Location) '.venv\Scripts\python.exe'
$bundledPython = Join-Path (Get-Location) 'runtime\python\python.exe'
if (Test-Path $bundledPython) { & $bundledPython bridge/wechat_bridge.py @args }
elseif (Test-Path $localPython) { & $localPython bridge/wechat_bridge.py @args }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3.12 bridge/wechat_bridge.py @args }
elseif (Get-Command python -ErrorAction SilentlyContinue) { & python bridge/wechat_bridge.py @args }
else { throw 'Python 3.12 not found. Create .venv or install Python and bridge requirements.' }
exit $LASTEXITCODE
