#Requires -Version 7.0

[CmdletBinding()]
param([switch] $CheckOnly)

& (Join-Path $PSScriptRoot "scripts/install-local.ps1") -Action Uninject -CheckOnly:$CheckOnly
exit $LASTEXITCODE
