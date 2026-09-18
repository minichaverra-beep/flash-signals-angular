#Requires -Version 5.1
<#
.SYNOPSIS
  Arranca la API Express de Flash Signals (puerto 3847).
.DESCRIPTION
  Cambia al directorio del proyecto, asegura dependencias si hace falta,
  define CURSOR_TRADING_ROOT si no está seteado, y ejecuta `npm run api`.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# UTF-8 en consola (evita mojibake en mensajes)
try {
  chcp 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
Set-Location -LiteralPath $ProjectRoot

Write-Host ""
Write-Host "=== Flash Signals API ===" -ForegroundColor Cyan
Write-Host "Directorio: $ProjectRoot"

# Dependencias raíz (Angular + scripts npm)
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Host "No hay node_modules en la raíz. Ejecutando: npm install --legacy-peer-deps ..." -ForegroundColor Yellow
  npm install --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Falló npm install en la raíz. Revisa Node/npm e inténtalo de nuevo."
    exit 1
  }
}

# Dependencias del servidor Express
$serverModules = Join-Path $ProjectRoot 'server\node_modules'
if (-not (Test-Path -LiteralPath $serverModules)) {
  Write-Host "No hay node_modules en server/. Ejecutando: npm install (en server) ..." -ForegroundColor Yellow
  Push-Location (Join-Path $ProjectRoot 'server')
  try {
    npm install
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Falló npm install en server/. Revisa e inténtalo de nuevo."
      exit 1
    }
  } finally {
    Pop-Location
  }
}

# Raíz del stack de señales (Cursor Trading)
if (-not $env:CURSOR_TRADING_ROOT -or [string]::IsNullOrWhiteSpace($env:CURSOR_TRADING_ROOT)) {
  $env:CURSOR_TRADING_ROOT = 'D:\Danilo\Trading\Cursor Trading'
  Write-Host "CURSOR_TRADING_ROOT no estaba definido; usando default:" -ForegroundColor Yellow
} else {
  Write-Host "CURSOR_TRADING_ROOT (ya definido):" -ForegroundColor Green
}
Write-Host "  $($env:CURSOR_TRADING_ROOT)"

if (-not (Test-Path -LiteralPath $env:CURSOR_TRADING_ROOT)) {
  Write-Warning "La ruta CURSOR_TRADING_ROOT no existe. La API arrancará, pero las señales fallarán al ejecutarse."
}

if (-not $env:PORT -or [string]::IsNullOrWhiteSpace($env:PORT)) {
  $env:PORT = '3847'
}

Write-Host ""
Write-Host "Arrancando API: npm run api  (http://localhost:$($env:PORT))" -ForegroundColor Green
Write-Host "Health: http://localhost:$($env:PORT)/api/health"
Write-Host "Ctrl+C para detener."
Write-Host ""

npm run api
exit $LASTEXITCODE
