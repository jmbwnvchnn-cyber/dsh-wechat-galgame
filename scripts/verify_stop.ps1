$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot 'stop.ps1'
if (-not (Test-Path -LiteralPath $file)) { throw 'Stop script missing.' }
$source = [System.IO.File]::ReadAllText($file)
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Stop script syntax errors.' }
$api = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-LocalApi'}, $true)
if (-not $api) { throw 'Existing local API helper missing.' }
$source = $source.Remove($api.Extent.StartOffset, $api.Extent.EndOffset - $api.Extent.StartOffset).Insert($api.Extent.StartOffset, @'
function Invoke-LocalApi([string]$path, [string]$method = 'GET', [string]$body = '') {
    if ($script:mode -eq 'offline') { throw 'synthetic offline' }
    if ($method -eq 'POST') {
        if (($body | ConvertFrom-Json).instance -cne 'owned') { throw 'Missing instance guard.' }
        $script:bridgeStops++
    }
    return @{instance='owned'; bridge=@{state='stopped'}}
}
'@)
$source = '$PSScriptRoot = ''C:\synthetic-gal\scripts''' + "`n" + $source
function Test-Stop([string]$mode) {
    $script:mode=$mode; $script:alive=$true; $script:stops=0; $script:bridgeStops=0
    function Write-Host {param($Object)}
    function Test-Path {param($LiteralPath) $true}
    function Get-Content {param([switch]$Raw,$Encoding,$LiteralPath) '{"port":3000}'}
    function Get-NetTCPConnection {param($LocalAddress,$LocalPort,$State,$ErrorAction) [pscustomobject]@{OwningProcess=43210}}
    function Start-Sleep {param($Milliseconds)}
    function Get-CimInstance {
        param($ClassName,$Filter,$ErrorAction)
        if (-not $script:alive -or $script:mode -eq 'stopped') {return}
        $exe = if ($script:mode -eq 'foreign') {'C:\foreign\node.exe'} else {'C:\synthetic-gal\runtime\node\node.exe'}
        $args = if ($script:mode -eq 'other-job') {' -e "console.log(1)"'} else {' server.js'}
        if ($script:mode -eq 'bridge-only') { $exe='C:\synthetic-gal\runtime\python\python.exe'; $args=' "C:\synthetic-gal\bridge\wechat_bridge.py"' }
        [pscustomobject]@{Name='node.exe';ProcessId=43210;ExecutablePath=$exe;CommandLine=('"'+$exe+'"'+$args);CreationDate= if($Filter -and $script:mode -eq 'reused'){'new'}else{'original'}}
    }
    function Stop-Process {
        param($Id,[switch]$Force,$ErrorAction)
        if ($Id -ne 43210) {throw 'Unexpected process target.'}
        $script:stops++;$script:alive=$false
    }
    $caught=''
    try {& ([scriptblock]::Create($source))} catch {$caught=$_.Exception.Message}
    if ($mode -in @('foreign','other-job','stopped','reused')) {
        if ($script:stops -ne 0) {throw "Unowned/replaced process stopped: $mode"}
    } else {
        if ($script:stops -ne 1 -or $caught) {throw "Owned service stop failed: $mode ($caught)"}
        if ($mode -eq 'owned' -and $script:bridgeStops -ne 1) {throw 'Bridge must stop through existing guarded API first.'}
    }
}
foreach($mode in @('owned','offline','foreign','other-job','stopped','reused','bridge-only')) {Test-Stop $mode}
Write-Output 'Stop checks passed: owned bridge/service, offline fallback, foreign process, unrelated job, already stopped, and PID replacement.'
