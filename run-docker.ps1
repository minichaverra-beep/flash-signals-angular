#Requires -Version 5.1
<#
.SYNOPSIS
  Levanta Flash Signals con Docker (sin Node/Angular en el host).
.DESCRIPTION
  Por defecto: servicios api + web (perfil full).
  Con -HostApi: solo web; proxy /api → host.docker.internal:3847
  (recomendado para señales reales: ejecuta .\run-api.ps1 en otra terminal).

  ARM64: usa .\run-docker-arm.ps1 o -Arm.
#>
[CmdletBinding()]
param(
  [switch]$HostApi,
  [switch]$Arm,
  [switch]$Build,
  [switch]$Down,
  [string]$TradingRoot = $env:CURSOR_TRADING_ROOT
)

$ErrorActionPreference = 'Stop'

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

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker no está instalado o no está en PATH. Instala Docker Desktop y reintenta."
    exit 1
  }
  docker info 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker no responde (¿Docker Desktop apagado?). Arráncalo e inténtalo de nuevo."
    exit 1
  }
}

Assert-Docker

if (-not $TradingRoot -or [string]::IsNullOrWhiteSpace($TradingRoot)) {
  $TradingRoot = 'D:\Danilo\Trading\Cursor Trading'
}
# Docker Desktop en Windows acepta bind sources con D:/ruta
$env:CURSOR_TRADING_ROOT = ($TradingRoot -replace '\\', '/')

Write-Host ""
Write-Host "=== Flash Signals Docker ===" -ForegroundColor Cyan
Write-Host "Proyecto: $ProjectRoot"
Write-Host "CURSOR_TRADING_ROOT (host): $($env:CURSOR_TRADING_ROOT)"

$composeFiles = @('-f', 'docker-compose.yml')
$profileArgs = @()

if ($Arm) {
  $composeFiles += @('-f', 'docker-compose.arm.yml')
  Write-Host "Plataforma: linux/arm64" -ForegroundColor Yellow
}

if ($HostApi) {
  $composeFiles += @('-f', 'docker-compose.host-api.yml')
}

if ($Down) {
  Write-Host "Deteniendo contenedores..." -ForegroundColor Yellow
  & docker compose @composeFiles --profile full down
  exit $LASTEXITCODE
}

if ($HostApi) {
  Write-Host "Modo HostApi: solo web; API esperada en el host (:3847)" -ForegroundColor Green
  Write-Host "  → En otra terminal: .\run-api.ps1" -ForegroundColor Green
  Write-Host ""
  Write-Host "NOTA: Las señales reales (PowerShell→Python) requieren la API en Windows." -ForegroundColor Yellow
  Write-Host "      Docker aquí sirve la UI estática + proxy a host.docker.internal." -ForegroundColor Yellow
} else {
  $profileArgs = @('--profile', 'full')
  Write-Host "Modo full: api + web en Docker" -ForegroundColor Green
  Write-Host ""
  Write-Host "LIMITACIÓN: el contenedor API es Linux/Node. Spawn de .ps1 Windows" -ForegroundColor Yellow
  Write-Host "  no es fiable aquí. Health/latest/chart pueden funcionar si el volumen" -ForegroundColor Yellow
  Write-Host "  trading está montado; para EJECUTAR señales usa:" -ForegroundColor Yellow
  Write-Host "    .\run-api.ps1   +   .\run-docker.ps1 -HostApi" -ForegroundColor Cyan
}

$upArgs = @('compose') + $composeFiles + $profileArgs + @('up', '-d', '--remove-orphans', '--build')

Write-Host ""
Write-Host ("docker " + ($upArgs -join ' ')) -ForegroundColor DarkGray
& docker @upArgs
if ($LASTEXITCODE -ne 0) {
  Write-Error "Falló docker compose up. Revisa el log arriba."
  exit $LASTEXITCODE
}

$webPort = if ($env:WEB_PORT) { $env:WEB_PORT } else { '8080' }
$apiPort = if ($env:API_PORT) { $env:API_PORT } else { '3847' }

Write-Host ""
Write-Host "Listo." -ForegroundColor Green
Write-Host "  UI:  http://localhost:$webPort"
if (-not $HostApi) {
  Write-Host "  API: http://localhost:$apiPort/api/health"
} else {
  Write-Host "  API (host): http://localhost:$apiPort/api/health  (debe estar con run-api.ps1)"
}
Write-Host ""
Write-Host "Logs:  docker compose $($composeFiles -join ' ') logs -f"
Write-Host "Bajar: .\run-docker.ps1 -Down$(if ($Arm) { ' -Arm' } else { '' })"
Write-Host ""
