$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))

# Adapted from whale-girl/scripts/stop-all.ps1. Match this installation's
# runtime AND entry script; never use a port alone as a termination target.
function Find-Targets {
    $found = @()
    $patterns = @(
        @{ Exe = (Join-Path $root 'runtime\node\node.exe'); Entry = 'server.js' },
        @{ Exe = (Join-Path $root 'runtime\python\python.exe'); Entry = 'bridge\wechat_bridge.py' }
    )
    foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction Stop)) {
        if ($proc.ProcessId -eq $PID -or -not $proc.CommandLine -or -not $proc.ExecutablePath) { continue }
        foreach ($pattern in $patterns) {
            if ($proc.ExecutablePath -ine $pattern.Exe) { continue }
            $arguments = [regex]::Match($proc.CommandLine, '^(?:"[^"]+"|\S+)\s+(.+)$').Groups[1].Value.Replace('/', '\')
            $entryPattern = '^(?:"?(?:' + [regex]::Escape($root + '\') + '|\.\\)?' + [regex]::Escape($pattern.Entry) + '"?)(?:\s|$)'
            if ($arguments -notmatch $entryPattern) { continue }
            $found += $proc
        }
    }
    return $found
}

# Same loopback API helper as scripts/start.ps1.
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

$targets = @(Find-Targets)
if (-not $targets.Count) { Write-Host 'gal 服务已经关闭。'; return }

# Stop the managed bridge through its existing guarded API when available.
# An unavailable API or malformed config still permits stopping owned processes.
try {
    $config = Get-Content -LiteralPath (Join-Path $root 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $port = if ($null -ne $config.port) { $config.port } else { 3000 }
    if (($port -is [int] -or $port -is [long]) -and $port -ge 1 -and $port -le 65535) {
        $owners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
        $servers = @($targets | Where-Object { $_.ExecutablePath -ieq (Join-Path $root 'runtime\node\node.exe') })
        if ($servers | Where-Object { $_.ProcessId -in $owners }) {
            $base = "http://127.0.0.1:$port"
            $status = Invoke-LocalApi '/api/setup/status'
            $instance = $status.instance
            if (-not [string]::IsNullOrEmpty($instance)) {
                $body = @{action='stop';instance=$instance} | ConvertTo-Json -Compress
                $null = Invoke-LocalApi '/api/setup/bridge' 'POST' $body
                $deadline = (Get-Date).AddSeconds(10)
                do {
                    $status = Invoke-LocalApi '/api/setup/status'
                    if ($status.instance -cne $instance -or -not $status.bridge.pid) { break }
                    Start-Sleep -Milliseconds 200
                } while ((Get-Date) -lt $deadline)
            }
        }
    }
} catch { }

for ($pass = 1; $pass -le 3; $pass++) {
    foreach ($target in @(Find-Targets)) {
        $current = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $target.ProcessId) -ErrorAction Stop
        if (-not $current -or $current.ExecutablePath -ine $target.ExecutablePath -or $current.CreationDate -ne $target.CreationDate) { continue }
        Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
    }
    if (-not @(Find-Targets).Count) { break }
    Start-Sleep -Milliseconds 200
}
if (@(Find-Targets).Count) { throw 'gal 仍有进程未关闭，请检查是否有另一个启动窗口正在重启服务。' }
Write-Host 'gal 服务和桥接已关闭。好感、记忆和设置已保留。'
