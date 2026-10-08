#Requires -Version 5.1
<#
.SYNOPSIS
  Empaqueta Cursor Trading + Flash Signals para instalar en Android (Termux + Ubuntu proot).
.DESCRIPTION
  1. Compila Angular (dist/) salvo -SkipBuild.
  2. Copia ambos repos sin .git, node_modules ni caches (incluye models/, data/*.parquet y .pt).
  3. Fija versiones Python del PC (scikit-learn/joblib/numpy deben coincidir con los .joblib).
  4. Genera android\out\flash-android.tar.gz + termux-install.sh.
  Copia esos dos archivos a la carpeta Download del teléfono.
  Detén la API (run-api.ps1) antes de empaquetar para que los .sqlite queden consistentes.
#>
[CmdletBinding()]
param(
  [string]$TradingRoot = $(if ($env:CURSOR_TRADING_ROOT) { $env:CURSOR_TRADING_ROOT } else { 'D:\Danilo\Trading\Cursor Trading' }),
  [string]$OutDir = '',
  [string]$Python = 'python',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppRoot = Split-Path -Parent $ScriptDir
if (-not $OutDir) { $OutDir = Join-Path $ScriptDir 'out' }

if (-not (Test-Path -LiteralPath $TradingRoot)) { throw "No existe Cursor Trading en: $TradingRoot" }

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

$stage = Join-Path $env:TEMP 'flash-android-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

$excludeDirs = @('.git', 'node_modules', '.angular', '__pycache__', '.pytest_cache', '.sonarlint',
  '.run-logs', '_imgs_dl', '.scannerwork', 'out')
$excludeFiles = @('.coverage', 'coverage.xml', '*.pyc')

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

Remove-Item $stage -Recurse -Force
$mb = [math]::Round((Get-Item $tarPath).Length / 1MB, 1)
Write-Host ''
Write-Host "Listo ($mb MB):" -ForegroundColor Green
Write-Host "  $tarPath"
Write-Host "  $(Join-Path $OutDir 'termux-install.sh')"
Write-Host 'Copia ambos a Download/ del telefono y en Termux ejecuta:' -ForegroundColor Yellow
Write-Host '  bash /sdcard/Download/termux-install.sh' -ForegroundColor Yellow
