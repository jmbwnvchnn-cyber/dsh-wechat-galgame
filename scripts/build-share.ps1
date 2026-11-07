$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$release = Join-Path $root 'release'
New-Item -ItemType Directory -Path $release -Force | Out-Null
$release = (Resolve-Path -LiteralPath $release).Path
$stage = Join-Path $release ('.stage-' + [guid]::NewGuid().ToString('N'))
$stagePrefix = $release.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $stage.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '暂存目录不在 release 目录中。' }
$zip = Join-Path $release 'gal-portable.zip'
$localGroupNames = @()
$privateValues = [System.Collections.Generic.List[string]]::new()
function Add-PrivateValue($value) {
    if ($value -is [string] -and $value.Length -ge 8 -and -not $privateValues.Contains($value)) {
        $privateValues.Add($value)
    }
}
function Add-KeyValues($value) {
    if ($value -is [string]) {
        if ($value.Length -ge 16) { Add-PrivateValue $value }
    } elseif ($value -is [pscustomobject]) {
        foreach ($property in $value.PSObject.Properties) { Add-KeyValues $property.Value }
    } elseif ($value -is [System.Collections.IEnumerable]) {
        foreach ($item in $value) { Add-KeyValues $item }
    }
}
$localConfig = Join-Path $root 'config.json'
if (Test-Path -LiteralPath $localConfig -PathType Leaf) {
    $local = Get-Content -LiteralPath $localConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($local.preferredGroupName -is [string] -and $local.preferredGroupName) { $localGroupNames += $local.preferredGroupName }
    if ($local.wechatBridge.groupNames) { $localGroupNames += @($local.wechatBridge.groupNames | Where-Object { $_ -is [string] -and $_ }) }
    $localGroupNames = @($localGroupNames | Select-Object -Unique)
    # 测试 is ordinary public prose throughout upstream demos and our UI.
    # Local config/data are excluded regardless of the selected group's name.
    $localGroupNames = @($localGroupNames | Where-Object { $_ -cne '测试' })
    foreach ($value in @($local.bridgeToken, $local.modelApiKey, $local.botUserId,
            $local.wechatBridge.account, $local.wechatBridge.botUserId, $local.wechatBridge.dbDir) + @($local.groupAllowlist)) {
        Add-PrivateValue $value
    }
}
$localData = Join-Path $root 'data'
if (Test-Path -LiteralPath $localData -PathType Container) {
    $keyFiles = @(Get-ChildItem -LiteralPath $localData -Recurse -File -Filter '*.json' | Where-Object {
        $_.Name -eq 'keys.json' -or $_.Directory.Name -eq 'keys'
    })
    foreach ($keyFile in $keyFiles) { Add-KeyValues (Get-Content -LiteralPath $keyFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json) }
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    $files = @('LICENSE','server.js','package.json','README.md','THIRD_PARTY_NOTICES.md','config.example.json','start.bat','start-service.bat','stop-service.bat','diagnose-bridge.bat')
    foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage }
    foreach ($dir in @('app','src','web','bridge')) {
        $source = Join-Path $root $dir
        if (Test-Path -LiteralPath $source -PathType Container) { Copy-Item -LiteralPath $source -Destination $stage -Recurse }
    }
    New-Item -ItemType Directory -Path (Join-Path $stage 'docs') -Force | Out-Null
    foreach ($file in @('wechat-setup.md','webhook.md','gameplay.md','privacy.md','development.md')) {
        $source = Join-Path $root "docs\$file"
        if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination (Join-Path $stage 'docs') }
    }
    New-Item -ItemType Directory -Path (Join-Path $stage 'scripts') -Force | Out-Null
    foreach ($file in @('start.ps1','stop.ps1','start-bridge.ps1','init-config.js','setup_probe.py')) { Copy-Item -LiteralPath (Join-Path $root "scripts\$file") -Destination (Join-Path $stage 'scripts') }
    New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'runtime\node') -Destination (Join-Path $stage 'runtime\node') -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'runtime\python') -Destination (Join-Path $stage 'runtime\python') -Recurse
    $caches = @(Get-ChildItem -LiteralPath $stage -Recurse -Directory -Force | Where-Object { $_.Name -eq '__pycache__' } | Sort-Object { $_.FullName.Length } -Descending)
    foreach ($cache in $caches) { if (Test-Path -LiteralPath $cache.FullName -PathType Container) { Remove-Item -LiteralPath $cache.FullName -Recurse -Force } }
    Get-ChildItem -LiteralPath $stage -Recurse -File -Force | Where-Object { $_.Extension -eq '.pyc' } | Remove-Item -Force
    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        # Windows PowerShell 5.1 can emit backslash ZIP entry paths.
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        $required = @('LICENSE','docs/privacy.md','docs/gameplay.md','docs/development.md','start.bat','start-service.bat','server.js','runtime/node/node.exe','runtime/node/LICENSE','runtime/python/python.exe','runtime/python/LICENSE.txt','config.example.json','README.md','THIRD_PARTY_NOTICES.md','web/setup.html','web/setup.js','scripts/start.ps1','scripts/start-bridge.ps1','docs/wechat-setup.md')
        foreach ($entry in $required) { if ($entry -notin $entries) { throw "分享包缺少必要文件：$entry" } }
        foreach ($entry in @('stop-service.bat','scripts/stop.ps1')) { if ($entry -notin $entries) { throw "分享包缺少关闭入口：$entry" } }
        $forbidden = @('config.json','data/','docs/superpowers/','.superpowers/','.venv/','release/')
        foreach ($pattern in $forbidden) { if ($entries | Where-Object { $_ -eq $pattern -or $_.StartsWith($pattern, [StringComparison]::OrdinalIgnoreCase) }) { throw "分享包包含禁止文件：$pattern" } }
        if ($entries | Where-Object { $_ -match '^docs/superpowers/' -or $_ -match '(^|/)\.task[^/]*/' -or $_ -match '(^|/)\.venv/' -or $_ -match '(^|/)release/' }) { throw '分享包包含开发或构建文件。' }
        if ($entries | Where-Object { $_.EndsWith('.pyc') -or $_ -match '(^|/)__pycache__(/|$)' }) { throw '分享包包含 Python 缓存文件。' }
        foreach ($entry in $archive.Entries | Where-Object { $_.FullName -match '\.(md|js|ps1|html|json|py)$' }) {
            $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
            try {
                $text = $reader.ReadToEnd()
                foreach ($groupName in $localGroupNames) { if ($text.Contains($groupName)) { throw '分享包中发现本机群名。' } }
                foreach ($value in $privateValues) { if ($text.Contains($value)) { throw "分享包中发现本机账号或凭据：$($entry.FullName)" } }
            } finally { $reader.Dispose() }
        }
        # Every archive file must be the current allowlisted source file. This
        # detects stale payloads and additions as well as accidental transforms.
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            foreach ($entry in $archive.Entries | Where-Object { $_.Name }) {
                $sourceFile = Join-Path $root ($entry.FullName.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
                if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) { throw "分享包文件没有源文件：$($entry.FullName)" }
                $packedStream = $entry.Open()
                $sourceStream = [System.IO.File]::OpenRead($sourceFile)
                try {
                    $packedHash = [System.BitConverter]::ToString($sha.ComputeHash($packedStream))
                    $sourceHash = [System.BitConverter]::ToString($sha.ComputeHash($sourceStream))
                    if ($packedHash -ne $sourceHash) { throw "分享包不是当前源文件：$($entry.FullName)" }
                } finally { $packedStream.Dispose(); $sourceStream.Dispose() }
            }
        } finally { $sha.Dispose() }
    } finally { $archive.Dispose() }
    $item = Get-Item -LiteralPath $zip
    Write-Host "分享包已生成：$($item.FullName)"
    Write-Host ("大小：{0:N1} MB" -f ($item.Length / 1MB))
    Write-Host "审计通过：$($entries.Count) 个条目；当前源文件一致；本机群名、账号、令牌与密钥未检出。"
    Write-Host ("SHA256：" + (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash)
} finally {
    if (Test-Path -LiteralPath $stage) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
        if ($resolvedStage.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
    }
}
