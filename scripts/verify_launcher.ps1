$ErrorActionPreference = 'Stop'
$source = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'start.ps1'))
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Launcher syntax errors.' }
$api = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-LocalApi' }, $true)
if (-not $api) { throw 'Launcher API boundary missing.' }
# Exercise the launcher control flow, replacing only the HTTP boundary. All
# process, file and browser operations below are synthetic; no service is run.
$source = $source.Remove($api.Extent.StartOffset, $api.Extent.EndOffset - $api.Extent.StartOffset).Insert($api.Extent.StartOffset, @'
function Invoke-LocalApi([string]$path, [string]$method = 'GET', [string]$body = '') {
    Invoke-MockApi $path $method $body
}
'@)
$source = '$PSScriptRoot = ''C:\synthetic-gal\scripts''' + "`n" + $source

function Assert([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Test-Launcher([string]$mode) {
    $script:mode = $mode
    $script:nonce = ''
    $script:browserCount = 0
    $script:stopCount = 0
    $script:apiCalls = [System.Collections.Generic.List[object]]::new()
    $script:child = [pscustomobject]@{ Id = 912345; HasExited = $false; ExitCode = 0 }
    function Set-Location { param($Path) }
    function Get-Location { [pscustomobject]@{ Path = 'C:\synthetic-gal' } }
    function Test-Path { param($LiteralPath) $true }
    function Get-Content { param([switch]$Raw, $Encoding, $Path) '{"port":3000}' }
    function Write-Host { param($Object) }
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
        if ($PassThru) {
            Assert ($WindowStyle -eq 'Hidden') 'Server launch must remain hidden.'
            $script:nonce = $env:GAL_SERVER_INSTANCE
            Assert (-not [string]::IsNullOrEmpty($script:nonce)) 'Child must inherit a perlaunch nonce.'
            return $script:child
        }
        $script:browserCount++
        throw 'synthetic browser boundary'
    }
    function Stop-Process {
        param($Id, [switch]$Force, $ErrorAction)
        Assert ($Id -eq $script:child.Id) 'Only the owned process may be force stopped.'
        $script:stopCount++
        $script:child.HasExited = $true
    }
    function Invoke-MockApi($path, $method, $body) {
        $script:apiCalls.Add([pscustomobject]@{ Path = $path; Method = $method; Body = $body })
        if ($method -eq 'POST') {
            $data = $body | ConvertFrom-Json
            Assert ($data.instance -ceq $script:nonce) 'Cleanup mutation must carry its own instance marker.'
            return @{ bridge = @{ state = 'stopped' } }
        }
        $marker = if ($script:mode -eq 'occupied' -or ($script:mode -eq 'replaced' -and $script:apiCalls.Count -gt 1)) { 'another-instance' } else { $script:nonce }
        return @{ instance = $marker; configured = $false; bridge = @{ state = 'stopped' } }
    }
    $previousInstance = $env:GAL_SERVER_INSTANCE
    $caught = ''
    try { & ([scriptblock]::Create($source)) } catch { $caught = $_.Exception.Message }
    Assert ($env:GAL_SERVER_INSTANCE -ceq $previousInstance) 'Launcher must restore the caller environment.'
    Assert ($script:stopCount -eq 1) "Test child must be stopped exactly once (caught: $caught)."
    $posts = @($script:apiCalls | Where-Object Method -eq 'POST')
    if ($mode -eq 'occupied') {
        Assert ($caught -match '另一服务实例占用') 'Occupied port must report an instance mismatch.'
        Assert ($script:browserCount -eq 0) 'A foreign responder must never be opened as this launch.'
        Assert ($posts.Count -eq 0) 'A foreign responder must receive no stop mutation.'
    } elseif ($mode -eq 'replaced') {
        Assert ($script:browserCount -eq 1) 'An owned service may be opened.'
        Assert ($posts.Count -eq 0) 'A replaced instance must receive no stop mutation.'
    } else {
        Assert ($script:browserCount -eq 1) 'Owned service should open once.'
        Assert ($posts.Count -eq 1) 'Owned cleanup should send exactly one guarded stop.'
    }
}

Test-Launcher 'occupied'
Test-Launcher 'replaced'
Test-Launcher 'owned'
Write-Output 'Launcher simulated checks passed: occupied port, replacement, owned cleanup, and nonce propagation.'
