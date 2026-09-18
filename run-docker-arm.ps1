#Requires -Version 5.1
<#
.SYNOPSIS
  Igual que run-docker.ps1 forzando linux/arm64 (Docker buildx / Apple Silicon / Windows ARM).
.DESCRIPTION
  Usa docker-compose.arm.yml (platform: linux/arm64).
  Requiere Docker Desktop con soporte multi-arch / buildx.
#>
[CmdletBinding()]
param(
  [switch]$HostApi,
  [switch]$Build,
  [switch]$Down
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if (-not $here) {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$script = Join-Path $here 'run-docker.ps1'
$argsList = @('-Arm')
if ($HostApi) { $argsList += '-HostApi' }
if ($Build) { $argsList += '-Build' }
if ($Down) { $argsList += '-Down' }

Write-Host "=== Flash Signals Docker (ARM64) ===" -ForegroundColor Cyan
Write-Host "Delegando a run-docker.ps1 $($argsList -join ' ')" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Tip multi-arch (opcional, buildx):" -ForegroundColor Yellow
Write-Host '  docker buildx create --name flash-signals --use'
Write-Host '  docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile.web -t flash-signals-web:multi --load .'
Write-Host ""

& $script @argsList
exit $LASTEXITCODE
