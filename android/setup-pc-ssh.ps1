#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Prepara el PC con MetaTrader 5 para que la app Android envíe operaciones por un túnel SSH.
.DESCRIPTION
  El puente MT5 sigue escuchando solo en 127.0.0.1. El teléfono (~/flash-mt5-tunnel.sh) abre un
  túnel SSH y reenvía 127.0.0.1:8765/8766 del teléfono a 127.0.0.1:8765/8766 de este PC.
  1. Instala y arranca OpenSSH Server (inicio automático).
  2. Abre el puerto 22 solo en redes privadas/dominio (marca tu Wi-Fi como «Privada»).
  3. Autoriza la clave del teléfono restringida: sin consola y solo reenvío a 127.0.0.1:8765/8766.
.PARAMETER PublicKey
  Línea «ssh-ed25519 AAAA… flash-android» que imprime ~/flash-mt5-tunnel.sh --setup.
.EXAMPLE
  .\android\setup-pc-ssh.ps1 -PublicKey "ssh-ed25519 AAAAC3Nza... flash-android"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PublicKey
)

$ErrorActionPreference = 'Stop'
function Step([string]$msg) { Write-Host ">> $msg" -ForegroundColor Cyan }

$PublicKey = $PublicKey.Trim()
if ($PublicKey -notmatch '^ssh-ed25519 [A-Za-z0-9+/=]+( \S+)?$') {
  throw 'PublicKey no parece una clave ssh-ed25519 (copia la línea completa de flash-mt5-tunnel.sh --setup).'
}

Step 'OpenSSH Server...'
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
}
Set-Service sshd -StartupType Automatic
Start-Service sshd

Step 'Firewall (puerto 22 solo en redes privadas/dominio)...'
$ruleName = 'OpenSSH-Server-In-TCP'
if (Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue) {
  Set-NetFirewallRule -Name $ruleName -Enabled True -Profile Private, Domain
} else {
  New-NetFirewallRule -Name $ruleName -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound `
    -Protocol TCP -LocalPort 22 -Action Allow -Profile Private, Domain | Out-Null
}

Step 'Autorizando la clave del teléfono (solo túnel MT5)...'
$opts = 'restrict,port-forwarding,permitopen="127.0.0.1:8765",permitopen="127.0.0.1:8766",command="echo solo-tunel-mt5"'
$line = "$opts $PublicKey"

# sshd usa administrators_authorized_keys para cuentas administradoras y ~/.ssh/authorized_keys para
# el resto; se escribe en ambos para no depender de la pertenencia al grupo.
$adminKeys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$userKeys = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
foreach ($file in $adminKeys, $userKeys) {
  New-Item -ItemType Directory -Path (Split-Path $file) -Force | Out-Null
  $existing = if (Test-Path $file) { Get-Content $file } else { @() }
  if (-not ($existing | Where-Object { $_ -like "*$PublicKey*" })) {
    Add-Content -Path $file -Value $line -Encoding ascii
  }
}
# sshd ignora administrators_authorized_keys si alguien más que Administradores/SYSTEM puede leerlo
icacls $adminKeys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null

Step 'Datos para el teléfono...'
$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
  ForEach-Object { "$($_.IPAddress)  ($($_.InterfaceAlias))" }
Write-Host "   Usuario de Windows:  $env:USERNAME"
Write-Host '   IP del PC:'
$ips | ForEach-Object { Write-Host "     $_" }

$public = Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' }
if ($public) {
  Write-Host ''
  Write-Host "   Aviso: la red '$($public.Name -join ', ')' es Pública y el firewall no deja pasar SSH." -ForegroundColor Yellow
  Write-Host '   Márcala como Privada en Configuración > Red e Internet, o usa Tailscale.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'PC listo. Deja abiertos MetaTrader 5 y el puente (.\run-mt5-bridge.ps1 o .\run-api.ps1).' -ForegroundColor Green
Write-Host 'En el teléfono: ~/flash-mt5-tunnel.sh --check' -ForegroundColor Green
