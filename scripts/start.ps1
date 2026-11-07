$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$root = (Get-Location).Path
$node = Join-Path $root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw '随附 Node.js 运行环境缺失，请重新解压完整分享包。' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'config.json'))) {
    & $node (Join-Path $root 'scripts\init-config.js')
    if ($LASTEXITCODE -ne 0) { throw '无法初始化本机配置。' }
}
$config = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'config.json') | ConvertFrom-Json
$port = if ($null -ne $config.port) { $config.port } else { 3000 }
if (($port -isnot [int] -and $port -isnot [long]) -or $port -lt 1 -or $port -gt 65535) { throw 'config.json 中的端口无效。' }
$base = "http://127.0.0.1:$port"
$instance = [guid]::NewGuid().ToString('N')
$previousInstance = $env:GAL_SERVER_INSTANCE
try {
    $env:GAL_SERVER_INSTANCE = $instance
    $service = Start-Process -FilePath $node -ArgumentList @('server.js') -WorkingDirectory $root -WindowStyle Hidden -PassThru
} finally { $env:GAL_SERVER_INSTANCE = $previousInstance }
$ownsServer = $false
function Invoke-LocalApi([string]$path, [string]$method = 'GET', [string]$body = '') {
    $request = [System.Net.HttpWebRequest]::Create("$base$path")
    $request.Method = $method
    $request.Proxy = $null
    $request.Timeout = 2000
    if ($body) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $request.ContentType = 'application/json; charset=utf-8'
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Dispose()
    }
    $response = $request.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream(), [System.Text.Encoding]::UTF8)
        try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
    if ($content) { return ($content | ConvertFrom-Json) }
}
try {
    $deadline = (Get-Date).AddSeconds(30)
    $setupStatus = $null
    while ((Get-Date) -lt $deadline -and -not $service.HasExited) {
        $candidate = $null
        try { $candidate = Invoke-LocalApi '/api/setup/status' } catch { Start-Sleep -Milliseconds 400 }
        if ($candidate) {
            if ($candidate.instance -cne $instance) { throw '端口已被另一服务实例占用；本次启动已取消，未停止已有服务。' }
            if ($service.HasExited) { break }
            $setupStatus = $candidate
            $ownsServer = $true
            break
        }
    }
    if (-not $setupStatus) { throw '本地服务未能启动。请确认端口未被占用。' }
    $page = if ($setupStatus.configured) { '/' } else { '/setup.html' }
    Write-Host "本地管理地址：$base$page"
    Start-Process "$base$page"
    while (-not $service.HasExited) { Start-Sleep -Milliseconds 500 }
    if ($service.ExitCode -ne 0) { throw "服务已停止，退出代码：$($service.ExitCode)" }
} finally {
    if (-not $service.HasExited) {
        try {
            if (-not $ownsServer) { throw '本次启动未确认服务归属。' }
            $current = Invoke-LocalApi '/api/setup/status'
            if ($current.instance -cne $instance) { throw '服务实例已更改。' }
            # The server checks this marker again at the mutation itself, so a
            # replacement between GET and POST cannot stop another instance.
            $stopBody = @{ action = 'stop'; instance = $instance } | ConvertTo-Json -Compress
            $null = Invoke-LocalApi '/api/setup/bridge' 'POST' $stopBody
            $stopDeadline = (Get-Date).AddSeconds(10)
            while ((Get-Date) -lt $stopDeadline -and -not $service.HasExited) {
                try {
                    $current = Invoke-LocalApi '/api/setup/status'
                    if ($current.instance -cne $instance -or $current.bridge.state -eq 'stopped') { break }
                } catch { break }
                Start-Sleep -Milliseconds 250
            }
        } catch {}
        if (-not $service.HasExited) { Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue }
    }
}
