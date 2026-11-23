[CmdletBinding()]
param([string]$GoExecutable = 'go', [int]$WebPort = 4180, [int]$ApiPort = 8120, [int]$ManagementPort = 9120)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $repo '.data/file-preview/processes.json'
# 关闭由旧版入口拥有且启动时间吻合的进程，保留原预览目录。
if (Test-Path -LiteralPath $statePath) {
    foreach ($record in (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json)) {
        $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
        $started = if ($record.started -is [DateTime]) { $record.started.ToUniversalTime() } else { [DateTime]::Parse($record.started).ToUniversalTime() }
        if ($process -and $process.StartTime.ToUniversalTime().Ticks -eq $started.Ticks) {
            & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
        }
    }
}
& node (Join-Path $PSScriptRoot 'dev.mjs') --preview --legacy-preview --go-executable $GoExecutable --web-port $WebPort --api-port $ApiPort --management-port $ManagementPort
exit $LASTEXITCODE
