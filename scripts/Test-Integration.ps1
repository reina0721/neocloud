[CmdletBinding()]
param([string]$GoExecutable = 'go')
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'dev.mjs') --acceptance --go-executable $GoExecutable
exit $LASTEXITCODE
