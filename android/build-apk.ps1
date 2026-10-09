#Requires -Version 5.1
<#
.SYNOPSIS
  Genera android\out\FlashSignals.apk: lanzador Android con el paquete Termux embebido.
.DESCRIPTION
  1. Ejecuta pack-for-android.ps1 (salvo -SkipPack) → out\flash-android.tar.gz + termux-install.sh + VERSION.
  2. Los copia a app-launcher\app\src\main\assets\.
  3. Compila con Gradle (assembleDebug) y copia el APK a out\FlashSignals.apk.
  Instala el APK en el teléfono (USB / Drive) junto con Termux de F-Droid.
.PARAMETER SkipPack
  Reutiliza el paquete ya generado en out\.
.PARAMETER SkipBuild
  Pasa -SkipBuild a pack-for-android.ps1 (no recompila Angular).
#>
[CmdletBinding()]
param(
  [switch]$SkipPack,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir = Join-Path $ScriptDir 'out'
$Launcher = Join-Path $ScriptDir 'app-launcher'
$Assets = Join-Path $Launcher 'app\src\main\assets'

if (-not $SkipPack) {
  & (Join-Path $ScriptDir 'pack-for-android.ps1') -SkipBuild:$SkipBuild
}
foreach ($f in 'flash-android.tar.gz', 'termux-install.sh') {
  if (-not (Test-Path (Join-Path $OutDir $f))) { throw "Falta out\$f (ejecuta sin -SkipPack)." }
}

New-Item -ItemType Directory -Path $Assets -Force | Out-Null
Get-ChildItem $Assets -File | Remove-Item -Force
# aapt quita la extensión .gz de los assets: se embebe como .bundle y la app lo exporta como .tar.gz
Copy-Item (Join-Path $OutDir 'flash-android.tar.gz') (Join-Path $Assets 'flash-android.bundle') -Force
Copy-Item (Join-Path $OutDir 'termux-install.sh') $Assets -Force
$versionFile = Join-Path $OutDir 'VERSION'
if (Test-Path $versionFile) {
  Copy-Item $versionFile (Join-Path $Assets 'flash-version.txt') -Force
} else {
  Write-Warning 'Falta out\VERSION (paquete antiguo): la app no podra ofrecer "Actualizar a vX".'
}

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
if (-not $sdk -or -not (Test-Path $sdk)) { throw 'Define ANDROID_HOME con la ruta del Android SDK.' }
$sdkProp = ($sdk -replace '\\', '/')
[IO.File]::WriteAllText((Join-Path $Launcher 'local.properties'), "sdk.dir=$sdkProp`n")

# Antivirus con inspección TLS (p. ej. AVG): Java debe confiar en el almacén de Windows
$trust = '-Djavax.net.ssl.trustStoreType=Windows-ROOT'
$env:GRADLE_OPTS = $trust

Write-Host '>> Gradle assembleDebug...' -ForegroundColor Cyan
Push-Location $Launcher
try {
  & .\gradlew.bat assembleDebug --no-daemon "-Dorg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8 $trust"
  if ($LASTEXITCODE -ne 0) { throw "Gradle fallo ($LASTEXITCODE)" }
} finally { Pop-Location }

$apk = Join-Path $Launcher 'app\build\outputs\apk\debug\app-debug.apk'
$dest = Join-Path $OutDir 'FlashSignals.apk'
Copy-Item $apk $dest -Force
$mb = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host ''
Write-Host "Listo ($mb MB): $dest" -ForegroundColor Green
Write-Host 'Copialo al telefono e instalalo (permite "instalar apps desconocidas").' -ForegroundColor Yellow
