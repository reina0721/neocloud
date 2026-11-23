[CmdletBinding()]
param([string]$GoExecutable = 'go', [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $repo '.data/dev-processes.json')) {
    throw '请先运行 Stop-Dev.ps1 关闭旧版后台进程。'
}
if ($SkipInstall) { Write-Warning '统一入口始终按锁文件同步依赖。' }
& node (Join-Path $PSScriptRoot 'dev.mjs') --go-executable $GoExecutable
exit $LASTEXITCODE
