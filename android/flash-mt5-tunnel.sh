#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# flash-mt5-tunnel.sh — túnel SSH del teléfono al PC con MetaTrader 5 (Termux)
# =============================================================================
# El puente MT5 solo escucha en 127.0.0.1 del PC y la API solo acepta bridgeUrl
# loopback. El túnel lleva 127.0.0.1:8765/8766 del teléfono a 127.0.0.1:8765/8766
# del PC, así la app usa http://127.0.0.1:8765 sin exponer nada a la red.
#
#   ~/flash-mt5-tunnel.sh --setup   clave SSH + datos del PC (una sola vez)
#   ~/flash-mt5-tunnel.sh --check   ¿responde el puente a través del túnel?
#   ~/flash-mt5-tunnel.sh           mantiene el túnel y reconecta solo
#
# flash-server.sh lo arranca en segundo plano si existe ~/.flash-mt5.env.
# =============================================================================
set -uo pipefail

CONF="$HOME/.flash-mt5.env"
KEY="$HOME/.ssh/flash_mt5"
PORTS=(8765 8766)

setup() {
  pkg install -y openssh curl >/dev/null
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  [[ -f "$KEY" ]] || ssh-keygen -q -t ed25519 -N '' -C flash-android -f "$KEY"
  read -rp "IP o nombre del PC (Wi-Fi o Tailscale): " host
  read -rp "Usuario de Windows: " user
  read -rp "Puerto SSH [22]: " port
  printf 'MT5_PC_HOST=%q\nMT5_PC_USER=%q\nMT5_PC_PORT=%q\n' "$host" "$user" "${port:-22}" > "$CONF"
  echo ""
  echo "Clave pública del teléfono. En el PC (PowerShell como administrador):"
  echo "  .\\android\\setup-pc-ssh.ps1 -PublicKey \"$(cat "$KEY.pub")\""
}

check() {
  for p in "${PORTS[@]}"; do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$p/health")
    if [[ "$code" == "000" ]]; then
      echo "  127.0.0.1:$p  sin respuesta (¿túnel caído o puente apagado en el PC?)"
    else
      echo "  127.0.0.1:$p  OK (HTTP $code)"
    fi
  done
}

run() {
  [[ -f "$CONF" ]] || { echo "Falta $CONF: ejecuta $0 --setup" >&2; exit 1; }
  # shellcheck source=/dev/null
  source "$CONF"
  local fwd=()
  for p in "${PORTS[@]}"; do fwd+=(-L "127.0.0.1:$p:127.0.0.1:$p"); done
  while true; do
    ssh -N -i "$KEY" -p "$MT5_PC_PORT" \
      -o BatchMode=yes -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
      -o StrictHostKeyChecking=accept-new \
      "${fwd[@]}" "$MT5_PC_USER@$MT5_PC_HOST"
    echo "[mt5-tunnel] $(date '+%H:%M:%S') desconectado (código $?); reintento en 10 s" >&2
    sleep 10
  done
}

case "${1:-}" in
  --setup) setup ;;
  --check) check ;;
  *) run ;;
esac
