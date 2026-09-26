#Requires -Version 5.1
<#
.SYNOPSIS
  Abre dos consolas visibles: API (3847) y Web Angular (4400).
.DESCRIPTION
  Invoca run-api.ps1 y run-local-web.ps1; cada uno abre su propia ventana
  de PowerShell con logs/debug.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$apiScript = Join-Path $ProjectRoot 'run-api.ps1'
$webScript = Join-Path $ProjectRoot 'run-local-web.ps1'

if (-not (Test-Path -LiteralPath $apiScript)) {
  Write-Error "No se encontro run-api.ps1 en: $ProjectRoot"
  exit 1
}
if (-not (Test-Path -LiteralPath $webScript)) {
  Write-Error "No se encontro run-local-web.ps1 en: $ProjectRoot"
  exit 1
}

Write-Host ""
Write-Host "=== Flash Signals - API + Web ===" -ForegroundColor Cyan
Write-Host "Abriendo dos consolas visibles..." -ForegroundColor Green
Write-Host "  - Flash Signals API  -> http://localhost:3847"
Write-Host "  - Flash Signals Web  -> http://localhost:4400"
Write-Host ""

& $apiScript
& $webScript

Write-Host "Listo. Revisa las ventanas Flash Signals API y Flash Signals Web para ver los logs." -ForegroundColor Cyan
Write-Host ""
