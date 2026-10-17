#Requires -Version 5.1
<#
.SYNOPSIS
  Empaqueta Cursor Trading + Flash Signals para instalar en Android (Termux + Ubuntu proot).
.DESCRIPTION
  1. Compila Angular (dist/) salvo -SkipBuild.
  2. Copia ambos repos para el teléfono. El motor sale de la caché data\cursor-trading
     (la misma que usa la API en este PC). Si esa caché tiene cambios locales más nuevos
     que su sello .source-sha (p. ej. free_candles.py, signal_card.py), se empaqueta TAL CUAL
     y no se vuelve a bajar de GitHub (eso los pisaría). -RefreshEngine fuerza la descarga.
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
  [switch]$SkipBuild,
  # Vuelve a bajar el motor de GitHub aunque la caché local tenga cambios (los pisa).
  [switch]$RefreshEngine
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

# Archivo .py de app/ más nuevo que el sello .source-sha = ediciones locales que GitHub no tiene.
function Get-EngineLocalEdits([string]$root) {
  $stamp = Join-Path $root '.source-sha'
  if (-not (Test-Path -LiteralPath $stamp)) { return @() }
  $since = (Get-Item -LiteralPath $stamp).LastWriteTimeUtc
  $appDir = Join-Path $root 'app'
  if (-not (Test-Path -LiteralPath $appDir)) { return @() }
  return @(Get-ChildItem -LiteralPath $appDir -Recurse -File -Include *.py |
    Where-Object { $_.LastWriteTimeUtc -gt $since -and $_.FullName -notmatch '__pycache__' } |
    Sort-Object LastWriteTimeUtc -Descending)
}

# El teléfono necesita estos módulos del motor actual (gráfico con respaldo y tarjeta del servidor).
$EngineRequiredFiles = @(
  'app\models\free_candles.py',
  'app\models\broker_feed.py',
  'app\views\mpl_safe.py',
  'app\views\illustrate_high_entry.py',
  'app\views\signal_card.py',
  'scripts\analyze\analyze.sh'
)
function Assert-EngineFiles([string]$root, [string]$label) {
  $missing = @($EngineRequiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
  if ($missing.Count) {
    throw "El motor en $label no trae: $($missing -join ', '). El teléfono generaría la tarjeta sin gráfico."
  }
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
  if (-not $RefreshEngine -and (Test-EngineReady $cache)) {
    $edits = Get-EngineLocalEdits $cache
    if ($edits.Count) {
      Write-Host ">> Motor: caché local $cache con $($edits.Count) archivo(s) editados después del último sello:" -ForegroundColor Cyan
      foreach ($e in ($edits | Select-Object -First 8)) {
        Write-Host ("   {0:yyyy-MM-dd HH:mm}  {1}" -f $e.LastWriteTime, $e.FullName.Substring($cache.Length + 1)) -ForegroundColor DarkGray
      }
      Write-Host '   Se empaqueta tal cual (sin bajar GitHub, que los pisaría). Usa -RefreshEngine para forzar la descarga.' -ForegroundColor Yellow
      return (Resolve-Path -LiteralPath $cache).Path
    }
  }
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
Assert-EngineFiles $TradingRoot $TradingRoot
$newestPy = Get-ChildItem -LiteralPath (Join-Path $TradingRoot 'app') -Recurse -File -Include *.py |
  Where-Object { $_.FullName -notmatch '__pycache__' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($newestPy) {
  Write-Host ("   motor: {0}  (archivo más reciente {1:yyyy-MM-dd HH:mm} {2})" -f $TradingRoot, $newestPy.LastWriteTime, $newestPy.Name) -ForegroundColor DarkGray
}

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
# Lo que de verdad va en el paquete (no lo que había en el PC).
Assert-EngineFiles (Join-Path $stage 'Cursor Trading') 'el paquete (Cursor Trading)'
foreach ($must in @('server\index.js', 'server\signal-card.js', 'dist\flash-signals-angular\browser\index.html')) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage "flash-signals-angular\$must"))) { throw "Falta $must en el paquete" }
}

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
