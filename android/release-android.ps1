#Requires -Version 5.1

<#
.SYNOPSIS
  Un solo comando para publicar Flash Signals en el teléfono: build Angular + paquete + APK + entrega.
.DESCRIPTION
  No hace falta ejecutar pack-for-android.ps1 aparte: este script lo llama primero.
  1. pack-for-android.ps1 (salvo -SkipPack): ng build + copia web/servidor/motor Python →
     android\out\flash-android.tar.gz + termux-install.sh + VERSION. Si falla, se detiene aquí.
  2. build-apk.ps1 -SkipPack (embebe ese paquete) si hay Android SDK (ANDROID_HOME) y no se pasa -NoApk.
  3. Si hay un teléfono por adb (USB o Wi-Fi): instala/actualiza FlashSignals.apk y abre la app.
  4. -Serve: sirve android\out por HTTP en la Wi-Fi para que la app actualice sin cable ni APK nuevo
     (botón «Actualizar desde el PC (Wi-Fi)»). Ctrl+C para terminar.
.PARAMETER SkipPack
  No vuelve a empaquetar: reutiliza android\out\flash-android.tar.gz + VERSION del último paquete.
.PARAMETER SkipBuild
  Se pasa a pack-for-android.ps1: empaqueta sin recompilar Angular (usa dist\ existente).
.PARAMETER TradingRoot
  Se pasa a pack-for-android.ps1: motor Python local en lugar de la librería desplegada.
.EXAMPLE
  .\android\release-android.ps1                 # todo: build, paquete, APK, instalar por adb
.EXAMPLE
  .\android\release-android.ps1 -NoApk -Serve   # solo paquete nuevo y servirlo por Wi-Fi (rápido)
.EXAMPLE
  .\android\release-android.ps1 -SkipPack -Serve  # volver a servir el último paquete
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$SkipPack,
  [switch]$NoApk,
  [switch]$Serve,
  [int]$Port = 8848,
  [string]$Device = '',
  [string]$Python = 'python',
  [string]$TradingRoot = ''
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path $ScriptDir 'out'

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
$hasSdk = $sdk -and (Test-Path $sdk)
$willBuildApk = (-not $NoApk) -and $hasSdk

# Banner «[n/total] ...» con solo los pasos que de verdad van a correr.
$totalSteps = 1  # entrega al teléfono (adb) o aviso de cómo instalar
if (-not $SkipPack) { $totalSteps++ }
if ($willBuildApk) { $totalSteps++ }
if ($Serve) { $totalSteps++ }
$stepN = 0
function Step([string]$msg) {
  $script:stepN++
  Write-Host ''
  Write-Host "[$script:stepN/$totalSteps] $msg" -ForegroundColor Cyan
}

if (-not $SkipPack) {
  Step 'Empaquetando web + servidor + motor Python para Android (pack-for-android.ps1)...'
  $packArgs = @{ SkipBuild = $SkipBuild; Python = $Python }
  if ($TradingRoot) { $packArgs.TradingRoot = $TradingRoot }
  & (Join-Path $ScriptDir 'pack-for-android.ps1') @packArgs
  if (-not $?) { throw 'pack-for-android.ps1 falló: no se continúa con el APK ni la entrega.' }
} else {
  Write-Host '(-SkipPack: se reutiliza el último paquete de android\out)' -ForegroundColor DarkGray
}
foreach ($f in 'flash-android.tar.gz', 'termux-install.sh', 'VERSION') {
  if (-not (Test-Path (Join-Path $OutDir $f))) { throw "Falta out\$f (ejecuta sin -SkipPack)." }
}
$version = (Get-Content (Join-Path $OutDir 'VERSION') -Raw).Trim()

$apk = Join-Path $OutDir 'FlashSignals.apk'
$apkBuilt = $false
if ($NoApk) {
  Write-Host '(-NoApk: no se recompila el APK)' -ForegroundColor DarkGray
} elseif ($willBuildApk) {
  Step "Compilando FlashSignals.apk con el paquete v$version embebido (build-apk.ps1)..."
  & (Join-Path $ScriptDir 'build-apk.ps1') -SkipPack
  if (-not $?) { throw 'build-apk.ps1 falló: no se instala en el teléfono.' }
  if (-not (Test-Path $apk)) { throw "build-apk.ps1 terminó pero falta $apk" }
  $apkBuilt = $true
} else {
  Write-Warning 'Sin Android SDK (ANDROID_HOME): no se compila el APK. Usa -Serve para actualizar por Wi-Fi.'
}

$lanIps = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -in 'Dhcp', 'Manual' } |
    Select-Object -ExpandProperty IPAddress)
$pcUrl = if ($lanIps.Count) { "http://$($lanIps[0]):$Port" } else { '' }

Step "Entregando v$version al teléfono..."
$adb = if ($hasSdk) { Join-Path $sdk 'platform-tools\adb.exe' } else { '' }
if ($adb -and (Test-Path $adb)) {
  $ErrorActionPreference = 'Continue'
  $devices = @(& $adb devices 2>$null | Where-Object { $_ -match "`tdevice$" } | ForEach-Object { ($_ -split "`t")[0] })
  if ($Device) { $devices = @($devices | Where-Object { $_ -eq $Device }) }
  if ($devices.Count -eq 1) {
    $serial = $devices[0]
    if ($apkBuilt) {
      Write-Host "   Instalando FlashSignals.apk en $serial (conserva datos de la app)..." -ForegroundColor Cyan
      & $adb -s $serial install -r $apk 2>&1 | Select-Object -Last 1 | Write-Host
    }
    $start = @('shell', 'am', 'start', '-n', 'com.danilo.flashsignals/.MainActivity')
    if ($Serve -and $pcUrl) { $start += @('--es', 'pc_url', $pcUrl) }
    & $adb -s $serial @start 2>&1 | Out-Null
    Write-Host '   App abierta en el teléfono: pulsa el botón dorado.' -ForegroundColor Green
  } elseif ($devices.Count -gt 1) {
    Write-Warning "Hay $($devices.Count) teléfonos por adb: indica -Device <serie>."
  } else {
    Write-Host '(sin teléfono por adb: instala out\FlashSignals.apk a mano o usa -Serve)' -ForegroundColor DarkGray
  }
  $ErrorActionPreference = 'Stop'
} else {
  Write-Host '(sin adb en el SDK: instala out\FlashSignals.apk a mano o usa -Serve)' -ForegroundColor DarkGray
}

if (-not $Serve) {
  Write-Host ''
  Write-Host "Listo v$version." -ForegroundColor Green
  if (-not $apkBuilt) { Write-Host 'Para actualizar por Wi-Fi sin APK nuevo: .\android\release-android.ps1 -SkipPack -Serve' }
  return
}

Step "Sirviendo v$version por Wi-Fi (puerto $Port)..."
$serveDir = Join-Path $OutDir 'serve'
if (Test-Path $serveDir) { Remove-Item $serveDir -Recurse -Force }
New-Item -ItemType Directory -Path $serveDir | Out-Null
foreach ($f in 'VERSION', 'termux-install.sh', 'flash-android.tar.gz', 'FlashSignals.apk') {
  $src = Join-Path $OutDir $f
  if (-not (Test-Path $src)) { continue }
  try {
    New-Item -ItemType HardLink -Path (Join-Path $serveDir $f) -Target $src | Out-Null
  } catch {
    Copy-Item $src (Join-Path $serveDir $f)
  }
}

if (-not $pcUrl) { Write-Warning 'No encuentro la IP de la Wi-Fi del PC (ipconfig).' }
Write-Host ''
Write-Host '  En la app: «Actualizar desde el PC (Wi-Fi)» y escribe:' -ForegroundColor Yellow
foreach ($ip in $lanIps) { Write-Host "      http://${ip}:$Port" -ForegroundColor Yellow }
Write-Host "  APK nuevo desde Chrome del teléfono: <dirección>/FlashSignals.apk" -ForegroundColor DarkGray
Write-Host '  Si el teléfono no conecta, permite el puerto en el firewall (PowerShell como administrador):' -ForegroundColor DarkGray
Write-Host "      New-NetFirewallRule -DisplayName 'Flash Signals $Port' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private" -ForegroundColor DarkGray
Write-Host '  Ctrl+C para terminar.' -ForegroundColor DarkGray
& $Python -m http.server $Port --bind 0.0.0.0 --directory $serveDir
