[CmdletBinding()]
param([string]$GoExecutable = 'go')
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'build.mjs') --go-executable $GoExecutable
exit $LASTEXITCODE
