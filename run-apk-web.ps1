#Requires -Version 5.1
<#
.SYNOPSIS
  Simula en el escritorio el arranque del APK: API + web Angular, gráficos por Yahoo, sin MT5.
.DESCRIPTION
  Misma pareja que run-both.ps1 (API :3847 y Angular :4400), pero como android/start.sh:
  FS_DATA_SOURCE=yahoo y sin terminal64 ni puentes 8765/8766.
  La UI sigue siendo la web de escritorio. Las descargas nativas del APK
  (window.AndroidDownloader) no existen aquí; el botón Descargar usa el navegador.
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
$webUrl = 'http://localhost:4400/'

if (-not (Test-Path -LiteralPath $apiScript)) {
  Write-Error "No se encontro run-api.ps1 en: $ProjectRoot"
  exit 1
}
if (-not (Test-Path -LiteralPath $webScript)) {
  Write-Error "No se encontro run-local-web.ps1 en: $ProjectRoot"
  exit 1
}

function Test-LocalPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    return $client.ConnectAsync('127.0.0.1', $Port).Wait(400) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

Write-Host ""
Write-Host "=== Flash Signals - simulacion APK (web de escritorio) ===" -ForegroundColor Cyan
Write-Host "Imita el arranque del APK en el telefono, sobre la web local:" -ForegroundColor Green
Write-Host "  - Graficos, capturas WIN/LOSS, ATR y VIX salen de Yahoo (BTC-USD, YM=F/^DJI, GC=F)."
Write-Host "  - No se abre MetaTrader 5 ni los puentes 8765/8766."
Write-Host "  - La interfaz es la web de escritorio ($webUrl), no el WebView del APK."
Write-Host "  - Descargar usa el navegador. No hay AndroidDownloader ni la carpeta Descargas de Android."
Write-Host "FS_DATA_SOURCE=yahoo solo en la API que arranque este script." -ForegroundColor Yellow
Write-Host ""

if (Test-LocalPort 3847) {
  Write-Host "La API ya escucha en 3847. No se abre otra ventana y no se reinicia." -ForegroundColor Yellow
  Write-Host "Ese proceso no recibe FS_DATA_SOURCE=yahoo. Detenlo tu y vuelve a lanzar este script." -ForegroundColor Yellow
} else {
  & $apiScript -NoMt5 -DataSource yahoo
}

if (Test-LocalPort 4400) {
  Write-Host "La web ya escucha en 4400. No se abre otra ventana." -ForegroundColor Yellow
} else {
  & $webScript
  Write-Host "Esperando a que la web responda en el puerto 4400..." -ForegroundColor DarkGray
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline -and -not (Test-LocalPort 4400)) {
    Start-Sleep -Seconds 1
  }
}

Write-Host "Abriendo el navegador en $webUrl" -ForegroundColor Green
Start-Process $webUrl
Write-Host ""
Write-Host "Listo. Revisa las ventanas Flash Signals API y Flash Signals Web para ver los logs." -ForegroundColor Cyan
Write-Host ""
