#Requires -Version 5.1
<#
.SYNOPSIS
  Arranca la UI Angular de Flash Signals (puerto 4400).
.DESCRIPTION
  Cambia al directorio del proyecto, asegura dependencias si hace falta,
  y ejecuta `npm start` (ng serve + proxy hacia la API).
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
Write-Host "=== Flash Signals Web (Angular) ===" -ForegroundColor Magenta
Write-Host "Directorio: $ProjectRoot"

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Host "No hay node_modules. Ejecutando: npm install --legacy-peer-deps ..." -ForegroundColor Yellow
  npm install --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Falló npm install. Revisa Node/npm e inténtalo de nuevo."
    exit 1
  }
}

$proxy = Join-Path $ProjectRoot 'proxy.conf.json'
if (Test-Path -LiteralPath $proxy) {
  Write-Host "Proxy: proxy.conf.json ( /api → API local )" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Arrancando UI: npm start  (http://localhost:4400)" -ForegroundColor Green
Write-Host "Asegúrate de tener la API en http://localhost:3847 (.\run-api.ps1)."
Write-Host "Ctrl+C para detener."
Write-Host ""

npm start
exit $LASTEXITCODE
