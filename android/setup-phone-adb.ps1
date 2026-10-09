#Requires -Version 5.1
<#
.SYNOPSIS
  Prepara el teléfono por ADB (inalámbrico o USB) para Flash Signals: Termux de GitHub,
  permisos, allow-external-apps, ajustes de Android 15 e instalación de FlashSignals.apk.
.DESCRIPTION
  Sustituye los botones 1 y 2 de la app y los ajustes manuales de batería / procesos.
  - Termux de Google Play no trae RunCommandService: se desinstala y se instala el de GitHub.
  - El build de GitHub es debuggable: run-as permite escribir ~/.termux/termux.properties.
.EXAMPLE
  # Depuración inalámbrica: primero vincular (IP:puerto y código de "Vincular con código")
  .\android\setup-phone-adb.ps1 -PairAddress 192.168.1.50:37123 -PairCode 123456 -Device 192.168.1.50:41234
.EXAMPLE
  # Ya vinculado / USB
  .\android\setup-phone-adb.ps1 -Device 192.168.1.50:41234
#>
[CmdletBinding()]
param(
  [string]$Device = '',
  [string]$PairAddress = '',
  [string]$PairCode = '',
  [switch]$SkipApk
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path $ScriptDir 'out'
$TermuxHome = '/data/data/com.termux/files/home'
$Props = "$TermuxHome/.termux/termux.properties"

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "No encuentro adb en $adb (define ANDROID_HOME)." }

function Invoke-Adb {
  # adb escribe avisos en stderr: en PS 5.1 con 'Stop' serían errores terminantes
  $ErrorActionPreference = 'Continue'
  $out = & $adb @args 2>&1 | ForEach-Object { "$_" }
  return $out
}
function Invoke-Phone { Invoke-Adb -s $script:Serial @args }
function Step([string]$msg) { Write-Host ">> $msg" -ForegroundColor Cyan }

if ($PairAddress) {
  if (-not $PairCode) { throw 'Falta -PairCode.' }
  Step "Vinculando con $PairAddress..."
  $r = Invoke-Adb pair $PairAddress $PairCode
  if (-not ($r -match 'Successfully paired')) {
    # El primer intento tras arrancar el daemon a veces falla con "protocol fault"
    $r = Invoke-Adb pair $PairAddress $PairCode
  }
  if (-not ($r -match 'Successfully paired')) { throw "No se pudo vincular: $r" }
}

if ($Device) {
  Step "Conectando con $Device..."
  $job = Start-Job { param($a, $d) & $a connect $d 2>&1 | ForEach-Object { "$_" } } -ArgumentList $adb, $Device
  if (-not (Wait-Job $job -Timeout 30)) {
    Stop-Job $job
    Invoke-Adb kill-server | Out-Null
    $job = Start-Job { param($a, $d) & $a connect $d 2>&1 | ForEach-Object { "$_" } } -ArgumentList $adb, $Device
    Wait-Job $job -Timeout 30 | Out-Null
  }
  Receive-Job $job | Write-Host
  Remove-Job $job -Force
}

$devices = Invoke-Adb devices | Where-Object { $_ -match "`tdevice$" } | ForEach-Object { ($_ -split "`t")[0] }
if ($Device) { $devices = $devices | Where-Object { $_ -eq $Device } }
if (@($devices).Count -ne 1) { throw "Necesito exactamente un teléfono conectado (encontrados: $(@($devices).Count))." }
$script:Serial = @($devices)[0]
$model = Invoke-Phone shell getprop ro.product.model
$release = Invoke-Phone shell getprop ro.build.version.release
Write-Host "   Teléfono: $model · Android $release ($Serial)"

Step 'Revisando Termux...'
$installed = (Invoke-Phone shell pm list packages com.termux) -contains 'package:com.termux'
if ($installed) {
  $hasRunCommand = [int](Invoke-Phone shell "dumpsys package com.termux | grep -c RunCommandService") -gt 0
  if (-not $hasRunCommand) {
    Write-Host '   Termux de Google Play detectado (sin RunCommandService): se reemplaza por el de GitHub.' -ForegroundColor Yellow
    Invoke-Phone uninstall com.termux | Write-Host
    $installed = $false
  } else {
    Write-Host '   Termux compatible ya instalado.'
  }
}
if (-not $installed) {
  $termuxApk = Join-Path $OutDir 'termux-github-arm64.apk'
  if (-not (Test-Path $termuxApk)) {
    Step 'Descargando Termux (GitHub, arm64-v8a)...'
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $rel = Invoke-RestMethod https://api.github.com/repos/termux/termux-app/releases/latest -Headers @{ 'User-Agent' = 'flash-signals' }
    $asset = $rel.assets | Where-Object { $_.name -match 'arm64-v8a\.apk$' } | Select-Object -First 1
    Invoke-WebRequest $asset.browser_download_url -OutFile $termuxApk -UseBasicParsing
    Write-Host "   $($asset.name)"
  }
  Step 'Instalando Termux...'
  Invoke-Phone install $termuxApk | Select-Object -Last 1 | Write-Host
}

if (-not $SkipApk) {
  $flashApk = Join-Path $OutDir 'FlashSignals.apk'
  if (Test-Path $flashApk) {
    Step 'Instalando FlashSignals.apk...'
    Invoke-Phone install -r $flashApk | Select-Object -Last 1 | Write-Host
  } else {
    Write-Host '   (sin out\FlashSignals.apk: ejecuta build-apk.ps1 o instálalo a mano)' -ForegroundColor Yellow
  }
}

Step 'Preparando entorno de Termux (primer arranque)...'
Invoke-Phone shell monkey -p com.termux -c android.intent.category.LAUNCHER 1 | Out-Null
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep 3
  if (Invoke-Phone shell "run-as com.termux ls /data/data/com.termux/files/usr/bin/bash 2>/dev/null") { $ready = $true; break }
}
if (-not $ready) { throw 'Termux no terminó su primer arranque (abre Termux en el teléfono y reintenta).' }

Step 'Permisos...'
Invoke-Phone shell pm grant com.termux android.permission.READ_EXTERNAL_STORAGE | Out-Null
Invoke-Phone shell pm grant com.termux android.permission.WRITE_EXTERNAL_STORAGE | Out-Null
if ((Invoke-Phone shell pm list packages com.danilo.flashsignals) -contains 'package:com.danilo.flashsignals') {
  Invoke-Phone shell pm grant com.danilo.flashsignals com.termux.permission.RUN_COMMAND | Out-Null
}

Step 'allow-external-apps (paso 2 de la app)...'
if (Invoke-Phone shell "run-as com.termux grep ^allow-external-apps $Props 2>/dev/null") {
  Write-Host '   Ya estaba activo.'
} else {
  Invoke-Phone shell "run-as com.termux sh -c 'mkdir -p $TermuxHome/.termux; echo allow-external-apps = true >> $Props'" | Out-Null
  # Reiniciar Termux para que lea la propiedad (solo aquí: cortaría una instalación en curso)
  Invoke-Phone shell am force-stop com.termux | Out-Null
  Invoke-Phone shell monkey -p com.termux -c android.intent.category.LAUNCHER 1 | Out-Null
}

Step 'Android 15: batería y procesos en segundo plano...'
Invoke-Phone shell dumpsys deviceidle whitelist +com.termux | Out-Null
Invoke-Phone shell cmd appops set com.termux RUN_ANY_IN_BACKGROUND allow | Out-Null
Invoke-Phone shell cmd appops set com.termux RUN_IN_BACKGROUND allow | Out-Null
Invoke-Phone shell '/system/bin/device_config set_sync_disabled_for_tests persistent' | Out-Null
Invoke-Phone shell '/system/bin/device_config put activity_manager max_phantom_processes 2147483647' | Out-Null
Invoke-Phone shell settings put global settings_enable_monitor_phantom_procs false | Out-Null

Step 'Verificación...'
$checks = [ordered]@{
  'Termux con RunCommandService' = [int](Invoke-Phone shell "dumpsys package com.termux | grep -c RunCommandService") -gt 0
  'allow-external-apps activo'   = [bool](Invoke-Phone shell "run-as com.termux grep ^allow-external-apps $Props")
  'Flash Signals: RUN_COMMAND'   = [bool](Invoke-Phone shell "dumpsys package com.danilo.flashsignals | grep 'RUN_COMMAND: granted=true'")
  'Límite de procesos quitado'   = (Invoke-Phone shell settings get global settings_enable_monitor_phantom_procs) -eq 'false'
}
$allOk = $true
foreach ($k in $checks.Keys) {
  $ok = $checks[$k]
  if (-not $ok) { $allOk = $false }
  Write-Host ("   [{0}] {1}" -f $(if ($ok) { 'OK' } else { '--' }), $k) -ForegroundColor $(if ($ok) { 'Green' } else { 'Yellow' })
}

Invoke-Phone shell am start -n com.danilo.flashsignals/.MainActivity | Out-Null
Write-Host ''
if ($allOk) {
  Write-Host 'Teléfono listo. En la app pulsa el botón dorado ("Instalar Flash Signals"); al terminar arranca sola.' -ForegroundColor Green
} else {
  Write-Host 'Revisa los puntos marcados con -- (o repite el script).' -ForegroundColor Yellow
}
