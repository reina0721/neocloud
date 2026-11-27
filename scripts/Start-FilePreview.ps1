[CmdletBinding()]
param([string]$GoExecutable = 'go', [int]$WebPort = 4180, [int]$ApiPort = 8120, [int]$ManagementPort = 9120)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'dev.mjs') --preview --go-executable $GoExecutable --web-port $WebPort --api-port $ApiPort --management-port $ManagementPort
exit $LASTEXITCODE
