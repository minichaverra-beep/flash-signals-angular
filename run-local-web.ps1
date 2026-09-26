#Requires -Version 5.1
<#
.SYNOPSIS
  Abre una consola visible y arranca la UI Angular de Flash Signals (puerto 4400).
.DESCRIPTION
  Siempre lanza una ventana nueva de PowerShell titulada "Flash Signals Web"
  para ver logs/debug. Usa -InWindow solo internamente (proceso ya en esa ventana).
.PARAMETER InWindow
  Uso interno: ejecuta ng serve en la consola actual (no vuelve a abrir otra ventana).
#>
[CmdletBinding()]
param(
  [switch]$InWindow
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}

# --- Launcher: siempre abrir consola visible ---
if (-not $InWindow) {
  $psExe = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $psExe)) {
    $psExe = 'powershell.exe'
  }
  $argList = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -InWindow"
  Write-Host "Abriendo consola 'Flash Signals Web' (puerto 4400)..." -ForegroundColor Magenta
  Start-Process -FilePath $psExe -WorkingDirectory $ProjectRoot -ArgumentList $argList
  exit 0
}

# --- Trabajo real (dentro de la ventana dedicada) ---
try {
  $Host.UI.RawUI.WindowTitle = 'Flash Signals Web'
} catch { }

try {
  chcp 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

Set-Location -LiteralPath $ProjectRoot

Write-Host ""
Write-Host "=== Flash Signals Web (Angular) ===" -ForegroundColor Magenta
Write-Host "Directorio: $ProjectRoot"

if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Host "No hay node_modules. Ejecutando: npm install --legacy-peer-deps ..." -ForegroundColor Yellow
  npm install --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Falló npm install. Revisa Node/npm e inténtalo de nuevo." -ForegroundColor Red
    Write-Host ""
    Write-Host "Pulsa Enter para cerrar esta ventana..." -ForegroundColor Yellow
    Read-Host | Out-Null
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
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }

Write-Host ""
if ($exitCode -ne 0) {
  Write-Host "La UI terminó con error (código $exitCode)." -ForegroundColor Red
} else {
  Write-Host "La UI se detuvo (código $exitCode)." -ForegroundColor Yellow
}
Write-Host "Pulsa Enter para cerrar esta ventana..." -ForegroundColor Yellow
Read-Host | Out-Null
exit $exitCode
