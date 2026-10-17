#Requires -Version 5.1
<#
.SYNOPSIS
  Empaqueta Cursor Trading + Flash Signals para instalar en Android (Termux + Ubuntu proot).
.DESCRIPTION
  1. Compila Angular (dist/) salvo -SkipBuild.
  2. Copia ambos repos para el teléfono. El motor sale de la librería desplegada
     (flash-trading-signals en GitHub), no de D:\Danilo\Trading\Cursor Trading.
     No lleva el escritorio: scripts .ps1, Docker, el proyecto Gradle del APK,
     el secreto de admin del PC ni node_modules (Termux los instala con npm ci).
     Sí incluye models/, data/*.parquet y .pt.
  3. Fija versiones Python del PC (scikit-learn/joblib/numpy deben coincidir con los .joblib).
  4. Genera android\out\flash-android.tar.gz + termux-install.sh + VERSION (aaaa.MM.dd-HHmm).
  La app compara VERSION con la instalada y ofrece «Actualizar» solo si es más nueva.
  Lo habitual es usar release-android.ps1 (empaqueta, compila el APK y lo entrega al teléfono).
  Detén la API (run-api.ps1) antes de empaquetar para que los .sqlite queden consistentes.
#>
[CmdletBinding()]
param(
  [string]$TradingRoot = '',
  [string]$OutDir = '',
  [string]$Python = 'python',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Split-Path -Parent $ScriptDir
if (-not $OutDir) { $OutDir = Join-Path $ScriptDir 'out' }

$LegacyRoot = 'D:\Danilo\Trading\Cursor Trading'
$EngineEndpoint = if ($env:CURSOR_TRADING_ENDPOINT) { $env:CURSOR_TRADING_ENDPOINT.Trim() } else {
  'https://github.com/minichaverra-beep/flash-trading-signals/archive/refs/heads/main.tar.gz'
}
$EngineCommitUrl = if ($env:CURSOR_TRADING_COMMIT_URL) { $env:CURSOR_TRADING_COMMIT_URL.Trim() } else {
  'https://api.github.com/repos/minichaverra-beep/flash-trading-signals/commits/main'
}

function Test-EngineReady([string]$root) {
  return [bool]($root -and (Test-Path -LiteralPath (Join-Path $root 'scripts\analyze\analyze.sh')))
}

function Resolve-DeployedTradingRoot([string]$requested) {
  if (-not $requested -and $env:CURSOR_TRADING_ROOT) { $requested = $env:CURSOR_TRADING_ROOT.Trim() }
  $legacy = $false
  if ($requested) {
    $norm = $requested.TrimEnd('\')
    $legacy = ($norm -ieq $LegacyRoot.TrimEnd('\'))
    $useLocal = (-not $legacy) -or ($env:CURSOR_TRADING_LOCAL -eq '1')
    if ($useLocal -and (Test-EngineReady $requested)) { return (Resolve-Path -LiteralPath $requested).Path }
    if ($useLocal -and -not $legacy) { throw "No existe el motor en: $requested" }
  }

  $cache = if ($env:CURSOR_TRADING_CACHE) { $env:CURSOR_TRADING_CACHE } else { Join-Path $AppRoot 'data\cursor-trading' }
  Write-Host '>> Motor: librería desplegada flash-trading-signals (main)...' -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{ 'User-Agent' = 'flash-signals-angular'; 'Accept' = 'application/vnd.github+json' }
  $sha = ''
  try {
    $commit = Invoke-RestMethod -Uri $EngineCommitUrl -Headers $headers -TimeoutSec 20
    $sha = [string]$commit.sha
  } catch {
    Write-Warning "No se pudo leer el commit publicado: $($_.Exception.Message)"
  }
  $stampPath = Join-Path $cache '.source-sha'
  $stamp = if (Test-Path -LiteralPath $stampPath) { (Get-Content -LiteralPath $stampPath -Raw).Trim() } else { '' }
  if ($sha -and $stamp -eq $sha -and (Test-EngineReady $cache)) {
    Write-Host "   caché al día ($($sha.Substring(0, [Math]::Min(7, $sha.Length))))" -ForegroundColor DarkGray
    return $cache
  }

  $tmp = Join-Path $env:TEMP ('flash-trading-' + [guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $prevProgress = $ProgressPreference
  try {
    $tar = Join-Path $tmp 'engine.tar.gz'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $EngineEndpoint -OutFile $tar -UseBasicParsing -TimeoutSec 180
    $extract = Join-Path $tmp 'extract'
    New-Item -ItemType Directory -Path $extract | Out-Null
    & tar -xzf $tar -C $extract
    if ($LASTEXITCODE -ne 0) { throw "tar fallo al extraer el motor ($LASTEXITCODE)" }
    $dirs = @(Get-ChildItem -LiteralPath $extract -Directory)
    if ($dirs.Count -ne 1) { throw 'el tarball del motor no trae una sola carpeta raíz' }
    $extracted = $dirs[0].FullName
    if (-not (Test-EngineReady $extracted)) { throw 'el motor descargado no trae scripts/analyze/analyze.sh' }
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
    $roboArgs = @($extracted, $cache, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if (Test-Path -LiteralPath (Join-Path $cache 'live')) { $roboArgs += @('/XD', 'live') }
    & robocopy @roboArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy fallo instalando el motor ($LASTEXITCODE)" }
    $written = if ($sha) { $sha } else { 'unknown' }
    [IO.File]::WriteAllText($stampPath, ($written + "`n"))
    if ($sha) { Write-Host "   descargado ($($sha.Substring(0, [Math]::Min(7, $sha.Length))))" -ForegroundColor DarkGray }
    return $cache
  } catch {
    if (Test-EngineReady $cache) {
      Write-Warning "No se pudo actualizar el motor ($($_.Exception.Message)). Se usa la caché."
      return $cache
    }
    throw
  } finally {
    $ProgressPreference = $prevProgress
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$TradingRoot = Resolve-DeployedTradingRoot $TradingRoot

if (-not $SkipBuild) {
  Write-Host '>> ng build (dist/)...' -ForegroundColor Cyan
  Push-Location $AppRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build fallo ($LASTEXITCODE)" }
  } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $AppRoot 'dist\flash-signals-angular\browser\index.html'))) {
  throw 'Falta dist\flash-signals-angular\browser\index.html (ejecuta sin -SkipBuild).'
}

# NUL/CON/etc. son dispositivos de Windows. Remove-Item falla con «Función incorrecta».
function Remove-FlashTree([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  & cmd.exe /c "rmdir /s /q `"\\?\$path`""
  if (Test-Path -LiteralPath $path) { throw "No se pudo borrar $path" }
}

$stage = Join-Path $env:TEMP 'flash-android-stage'
Remove-FlashTree $stage
New-Item -ItemType Directory -Path $stage | Out-Null

# Escritorio y lo que Termux regenera. app-launcher es el Gradle del APK (solo el PC).
# cursor-trading es la caché del motor; en el teléfono va la copia «Cursor Trading».
$excludeDirs = @(
  '.git', 'node_modules', '.npm', '.angular', '__pycache__', '.pytest_cache', '.mypy_cache', '.sonarlint',
  '.run-logs', '_imgs_dl', '.scannerwork', 'out', '.github', '.vscode', '.cursor',
  'docker', 'app-launcher', 'cursor-trading'
)
$excludeFiles = @(
  '.coverage', 'coverage.xml', '*.pyc', '*.ps1', '*.test.js',
  '*.sqlite-shm', '*.sqlite-wal', 'admin-token-secret',
  'NUL', 'CON', 'PRN', 'AUX', 'COM1', 'LPT1'
)

function Copy-Repo([string]$src, [string]$name) {
  Write-Host ">> Copiando $name..." -ForegroundColor Cyan
  $dst = Join-Path $stage $name
  robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /XD @excludeDirs /XF @excludeFiles | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy fallo copiando $name ($LASTEXITCODE)" }
}
Copy-Repo $TradingRoot 'Cursor Trading'
Copy-Repo $AppRoot 'flash-signals-angular'

Write-Host '>> Fijando versiones Python del PC...' -ForegroundColor Cyan
$freeze = & $Python -m pip freeze
if ($LASTEXITCODE -ne 0) { throw 'pip freeze fallo' }
function Get-Pins([string[]]$names) {
  foreach ($n in $names) {
    $line = $freeze | Where-Object { $_ -match "^(?i)$([regex]::Escape($n))==" } | Select-Object -First 1
    if ($line) { $line -replace '\+.*$', '' } else { $n }
  }
}
$core = Get-Pins @('numpy', 'pandas', 'scipy', 'scikit-learn', 'joblib', 'pyarrow', 'yfinance',
  'matplotlib', 'pillow', 'PyYAML', 'pytest')
$neural = Get-Pins @('torch', 'torchvision')
$ocr = Get-Pins @('onnxruntime', 'rapidocr-onnxruntime')

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Lf([string]$path, [string[]]$lines) {
  [IO.File]::WriteAllText($path, (($lines -join "`n") + "`n"), $utf8)
}
Write-Lf (Join-Path $stage 'requirements-android.txt') $core
Write-Lf (Join-Path $stage 'requirements-android-neural.txt') $neural
Write-Lf (Join-Path $stage 'requirements-android-ocr.txt') $ocr

foreach ($f in 'setup-ubuntu.sh', 'start.sh') {
  Copy-Item (Join-Path $PSScriptRoot $f) (Join-Path $stage $f)
}

$version = Get-Date -Format 'yyyy.MM.dd-HHmm'
Write-Lf (Join-Path $stage 'VERSION') @($version)

# bash en Android no tolera CRLF
Get-ChildItem $stage -Recurse -File -Include *.sh, *.bash | ForEach-Object {
  $text = [IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"
  [IO.File]::WriteAllText($_.FullName, $text, $utf8)
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$tarPath = Join-Path $OutDir 'flash-android.tar.gz'
if (Test-Path $tarPath) { Remove-Item $tarPath -Force }
Write-Host '>> Comprimiendo flash-android.tar.gz...' -ForegroundColor Cyan
tar -czf $tarPath -C $stage .
if ($LASTEXITCODE -ne 0) { throw "tar fallo ($LASTEXITCODE)" }

$installer = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'termux-install.sh')) -replace "`r`n", "`n"
[IO.File]::WriteAllText((Join-Path $OutDir 'termux-install.sh'), $installer, $utf8)
Write-Lf (Join-Path $OutDir 'VERSION') @($version)

Remove-FlashTree $stage
$mb = [math]::Round((Get-Item $tarPath).Length / 1MB, 1)
Write-Host ''
Write-Host "Listo v$version ($mb MB):" -ForegroundColor Green
Write-Host "  $tarPath"
Write-Host "  $(Join-Path $OutDir 'termux-install.sh')"
Write-Host 'Siguiente: .\android\release-android.ps1 -SkipPack (APK + entrega al telefono) o -Serve (actualizar por Wi-Fi).' -ForegroundColor Yellow
