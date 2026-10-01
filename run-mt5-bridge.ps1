#Requires -Version 5.1
<#
.SYNOPSIS
  Arranca el puente local MT5 (mt5-bridge/bridge.py) en su propia consola.
.DESCRIPTION
  Requiere el terminal MetaTrader 5 abierto y logueado (cuenta DEMO por defecto)
  con "Algo Trading" activado. Instala la librería MetaTrader5 si falta.

  -Perfil principal  -> http://127.0.0.1:8765, token MT5_BRIDGE_TOKEN,
                        terminal MT5_TERMINAL_PATH (o el terminal abierto).
  -Perfil secundaria -> http://127.0.0.1:8766, token MT5_BRIDGE_TOKEN_SECUNDARIA,
                        terminal MT5_TERMINAL_PATH_SECUNDARIA.
  Los tokens se leen de la sesión o, si no están, de las variables de usuario.
.PARAMETER InWindow
  Uso interno: ejecuta el puente en la consola actual (no abre otra ventana).
#>
[CmdletBinding()]
param(
  [ValidateSet('principal', 'secundaria')]
  [string]$Perfil = 'principal',
  [switch]$InWindow
)

$ErrorActionPreference = 'Stop'

function Get-Setting([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) { $value = [Environment]::GetEnvironmentVariable($Name, 'User') }
  return $value
}

function Test-LocalPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    return $client.ConnectAsync('127.0.0.1', $Port).Wait(500) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

if (-not $InWindow) {
  if ($Perfil -eq 'secundaria') {
    $port = Get-Setting 'MT5_BRIDGE_PORT_SECUNDARIA'; if (-not $port) { $port = '8766' }
    $terminal = Get-Setting 'MT5_TERMINAL_PATH_SECUNDARIA'
    $tokenName = 'MT5_BRIDGE_TOKEN_SECUNDARIA'
  } else {
    $port = $env:MT5_BRIDGE_PORT; if (-not $port) { $port = '8765' }
    $terminal = Get-Setting 'MT5_TERMINAL_PATH'
    if (-not $terminal) { $terminal = Join-Path $env:ProgramFiles 'MetaTrader 5\terminal64.exe' }
    $tokenName = 'MT5_BRIDGE_TOKEN'
  }

  if (Test-LocalPort ([int]$port)) {
    Write-Host "MT5 Bridge ($Perfil) ya escucha en 127.0.0.1:$port; no se abre otro." -ForegroundColor Green
    exit 0
  }
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Warning "Python no está en el PATH: no se puede arrancar MT5 Bridge ($Perfil)."
    exit 1
  }
  if (-not (Get-Setting $tokenName)) {
    Write-Warning "$tokenName no está definido: el puente ($Perfil) arrancará sin token."
  }

  if ($terminal -and (Test-Path -LiteralPath $terminal)) {
    $running = Get-Process terminal64 -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and ($_.Path -ieq (Resolve-Path -LiteralPath $terminal).Path) }
    if (-not $running) {
      Write-Host "Abriendo terminal MetaTrader 5 ($Perfil): $terminal" -ForegroundColor Cyan
      Start-Process -FilePath $terminal
      Start-Sleep -Seconds 3
    }
  } elseif ($terminal) {
    Write-Warning "No existe el terminal MT5 en '$terminal'."
  }

  $psExe = Join-Path $PSHOME 'powershell.exe'
  if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
  $argList = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Perfil $Perfil -InWindow"
  Write-Host "Abriendo consola 'MT5 Bridge ($Perfil)' (127.0.0.1:$port)..." -ForegroundColor Cyan
  Start-Process -FilePath $psExe -WorkingDirectory $PSScriptRoot -ArgumentList $argList
  exit 0
}

$BridgeDir = Join-Path $PSScriptRoot 'mt5-bridge'
try { $Host.UI.RawUI.WindowTitle = "MT5 Bridge ($Perfil)" } catch { }

# Con "Edición rápida" activa, un clic en la ventana congela la escritura del log
# y el puente deja de responder (timeouts en /order y /health).
try {
  Add-Type -Namespace FlashSignals -Name ConsoleMode -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr hConsole, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr hConsole, uint mode);
'@
  $stdin = [FlashSignals.ConsoleMode]::GetStdHandle(-10)
  [uint32]$mode = 0
  if ([FlashSignals.ConsoleMode]::GetConsoleMode($stdin, [ref]$mode)) {
    [void][FlashSignals.ConsoleMode]::SetConsoleMode($stdin, (($mode -band 0xFFFFFFBF) -bor 0x80))
  }
} catch {
  Write-Warning "No se pudo desactivar 'Edición rápida': no hagas clic dentro de esta ventana."
}

try {
  if ($Perfil -eq 'secundaria') {
    $port = Get-Setting 'MT5_BRIDGE_PORT_SECUNDARIA'; if (-not $port) { $port = '8766' }
    $env:MT5_BRIDGE_PORT = $port
    $env:MT5_BRIDGE_TOKEN = Get-Setting 'MT5_BRIDGE_TOKEN_SECUNDARIA'
    $env:MT5_TERMINAL_PATH = Get-Setting 'MT5_TERMINAL_PATH_SECUNDARIA'
    if (-not $env:MT5_TERMINAL_PATH) {
      Write-Warning 'MT5_TERMINAL_PATH_SECUNDARIA no definido: el puente se conectará al terminal ya abierto (misma cuenta que la principal).'
    }
  } else {
    if (-not $env:MT5_BRIDGE_PORT) { $env:MT5_BRIDGE_PORT = '8765' }
    $env:MT5_BRIDGE_TOKEN = Get-Setting 'MT5_BRIDGE_TOKEN'
    $env:MT5_TERMINAL_PATH = Get-Setting 'MT5_TERMINAL_PATH'
  }

  python -c "import MetaTrader5" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Instalando MetaTrader5 (pip)..." -ForegroundColor Yellow
    python -m pip install -r (Join-Path $BridgeDir 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo instalar MetaTrader5 (requiere Python 64-bit en Windows).' }
  }

  $env:MT5_ALLOW_REAL = Get-Setting 'MT5_ALLOW_REAL'

  Write-Host "=== Flash Signals MT5 Bridge · $Perfil ===" -ForegroundColor Cyan
  Write-Host "Puerto: $($env:MT5_BRIDGE_PORT) · Token: $(if ($env:MT5_BRIDGE_TOKEN) { 'configurado' } else { 'SIN TOKEN' })"
  Write-Host "Terminal: $(if ($env:MT5_TERMINAL_PATH) { $env:MT5_TERMINAL_PATH } else { 'el que esté abierto' })"
  Write-Host "Cuenta REAL permitida: $(if ($env:MT5_ALLOW_REAL -eq '1') { 'SÍ' } else { 'NO (solo demo)' })"
  Write-Host ""
  python (Join-Path $BridgeDir 'bridge.py')
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
}
Write-Host ""
Write-Host "Pulsa Enter para cerrar esta ventana..." -ForegroundColor Yellow
Read-Host | Out-Null
