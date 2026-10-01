#Requires -Version 5.1
<#
.SYNOPSIS
  Abre una consola visible y arranca la API Express de Flash Signals (puerto 3847).
.DESCRIPTION
  Siempre lanza una ventana nueva de PowerShell titulada "Flash Signals API"
  para ver logs/debug. Usa -InWindow solo internamente (proceso ya en esa ventana).
  También prepara MT5 (run-mt5-bridge.ps1): abre el terminal MetaTrader 5 si
  no está abierto y lanza el puente de Conf principal (8765). Conf secundaria
  (8766) solo si MT5_TERMINAL_PATH_SECUNDARIA está definido. Los puentes que
  ya estén escuchando no se duplican.
.PARAMETER InWindow
  Uso interno: ejecuta la API en la consola actual (no vuelve a abrir otra ventana).
.PARAMETER NoMt5
  No arranca el terminal MT5 ni los puentes.
#>
[CmdletBinding()]
param(
  [switch]$InWindow,
  [switch]$NoMt5
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
  Write-Host "Abriendo consola 'Flash Signals API' (puerto 3847)..." -ForegroundColor Cyan
  Start-Process -FilePath $psExe -WorkingDirectory $ProjectRoot -ArgumentList $argList

  if (-not $NoMt5) {
    $bridgeScript = Join-Path $ProjectRoot 'run-mt5-bridge.ps1'
    if (Test-Path -LiteralPath $bridgeScript) {
      & $bridgeScript -Perfil principal
      $secondaryTerminal = [Environment]::GetEnvironmentVariable('MT5_TERMINAL_PATH_SECUNDARIA', 'Process')
      if (-not $secondaryTerminal) { $secondaryTerminal = [Environment]::GetEnvironmentVariable('MT5_TERMINAL_PATH_SECUNDARIA', 'User') }
      if ($secondaryTerminal) {
        & $bridgeScript -Perfil secundaria
      } else {
        Write-Host "Conf secundaria: sin MT5_TERMINAL_PATH_SECUNDARIA, no se arranca su puente." -ForegroundColor DarkGray
      }
      Write-Host "Recuerda: 'Algo Trading' debe estar activado en MetaTrader 5 para enviar órdenes." -ForegroundColor Yellow
    }
  }
  exit 0
}

# --- Trabajo real (dentro de la ventana dedicada) ---
try {
  $Host.UI.RawUI.WindowTitle = 'Flash Signals API'
} catch { }

try {
  chcp 65001 | Out-Null
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

Set-Location -LiteralPath $ProjectRoot

Write-Host ""
Write-Host "=== Flash Signals API ===" -ForegroundColor Cyan
Write-Host "Directorio: $ProjectRoot"

# Dependencias raíz (Angular + scripts npm)
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules'))) {
  Write-Host "No hay node_modules en la raíz. Ejecutando: npm install --legacy-peer-deps ..." -ForegroundColor Yellow
  npm install --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Falló npm install en la raíz. Revisa Node/npm e inténtalo de nuevo." -ForegroundColor Red
    Write-Host ""
    Write-Host "Pulsa Enter para cerrar esta ventana..." -ForegroundColor Yellow
    Read-Host | Out-Null
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
      Write-Host "Falló npm install en server/. Revisa e inténtalo de nuevo." -ForegroundColor Red
      Write-Host ""
      Write-Host "Pulsa Enter para cerrar esta ventana..." -ForegroundColor Yellow
      Read-Host | Out-Null
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
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }

Write-Host ""
if ($exitCode -ne 0) {
  Write-Host "La API terminó con error (código $exitCode)." -ForegroundColor Red
} else {
  Write-Host "La API se detuvo (código $exitCode)." -ForegroundColor Yellow
}
Write-Host "Pulsa Enter para cerrar esta ventana..." -ForegroundColor Yellow
Read-Host | Out-Null
exit $exitCode
