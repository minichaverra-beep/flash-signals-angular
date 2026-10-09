#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# termux-install.sh — instala / actualiza Flash Signals en Android (Termux)
# =============================================================================
# Normalmente lo lanza la app Flash Signals. Uso manual (en Termux):
#   bash termux-install.sh                     # busca flash-android.tar.gz en Download/
#   BUNDLE=/ruta/flash-android.tar.gz bash termux-install.sh
#   BUNDLE_URL=http://IP-PC:8848/flash-android.tar.gz bash termux-install.sh
#   bash termux-install.sh --fresh             # reinstala pisando historial
#
# Idempotente: solo instala paquetes Termux / Ubuntu / pip / npm si faltan o cambiaron.
# Actualizar conserva flash-signals-angular/data (historial SQLite) y Cursor Trading/live.
# Deja ~/.flash-install-state (running | ok | failed:<paso>), ~/.flash-version y ~/flash-install.log
# para que la app sepa qué pasó.
# Variables opcionales: SKIP_NEURAL=1  WITH_OCR=1
# =============================================================================
set -Eeuo pipefail

FRESH=0
[[ "${1:-}" == "--fresh" ]] && FRESH=1

DISTRO=ubuntu
APP=/opt/flash
PKG_DIR="$HOME/flash-pkg"
PKG_FILE="$PKG_DIR/flash-android.tar.gz"
STATE_FILE="$HOME/.flash-install-state"
LOG_FILE="$HOME/flash-install.log"
STEP="inicio"

: > "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

step() {
  STEP="$1"
  echo ""
  echo "==> $1"
}
on_error() {
  echo "failed:$STEP" > "$STATE_FILE"
  echo ""
  echo "ERROR en: $STEP (registro completo: $LOG_FILE)"
  echo "Corrige el problema (p. ej. Wi-Fi) y pulsa «Reintentar instalación» en la app."
}
trap on_error ERR
echo running > "$STATE_FILE"

step "Localizando el paquete"
BUNDLE="${BUNDLE:-}"
BUNDLE_URL="${BUNDLE_URL:-}"
mkdir -p "$PKG_DIR"
if [[ -n "$BUNDLE_URL" ]]; then
  command -v curl >/dev/null || pkg install -y curl
  echo "Descargando $BUNDLE_URL ..."
  curl -fL --retry 3 -o "$PKG_FILE.part" "$BUNDLE_URL"
  mv -f "$PKG_FILE.part" "$PKG_FILE"
  BUNDLE="$PKG_FILE"
elif [[ -z "$BUNDLE" ]]; then
  # Solo el uso manual necesita leer Download/ (la app pasa el paquete directo a Termux)
  if ! ls /sdcard/Download >/dev/null 2>&1; then
    echo "Concede el permiso de almacenamiento en el diálogo de Android..."
    termux-setup-storage
    for _ in $(seq 1 120); do
      ls /sdcard/Download >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  for cand in /sdcard/Download/flash-android.tar.gz /sdcard/Download/FlashSignals/flash-android.tar.gz; do
    [[ -f "$cand" ]] && BUNDLE="$cand" && break
  done
fi
if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "No encuentro flash-android.tar.gz (usa la app o BUNDLE=/ruta)."
  false
fi
if [[ "$(realpath "$BUNDLE")" != "$(realpath -m "$PKG_FILE")" ]]; then
  echo "Copiando paquete ($(du -h "$BUNDLE" | cut -f1))..."
  cp -f "$BUNDLE" "$PKG_FILE"
fi

step "Paquetes de Termux (proot-distro, openssh, curl)"
missing=()
for p in proot-distro openssh curl; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if (( ${#missing[@]} )); then
  echo "Instalando: ${missing[*]}"
  pkg update -y
  pkg install -y "${missing[@]}"
else
  echo "Ya instalados."
fi

step "Ubuntu (proot)"
if proot-distro login "$DISTRO" -- true 2>/dev/null; then
  echo "Ya instalado."
else
  proot-distro install "$DISTRO"
fi

in_ubuntu() {
  proot-distro login "$DISTRO" --bind "$PKG_DIR:/mnt/flash-pkg" -- "$@"
}

if pgrep -f 'server/inde[x]\.js' >/dev/null; then
  step "Deteniendo el servidor en marcha"
  pkill -f 'server/inde[x]\.js' || true
  pkill -f 'mt5-bridge/bridg[e]\.py' || true
  sleep 2
fi

if (( FRESH )); then
  step "Borrando instalación anterior (--fresh)"
  in_ubuntu rm -rf "$APP"
fi

if in_ubuntu test -d "$APP/flash-signals-angular"; then
  step "Actualizando archivos (se conservan historial y live/)"
  in_ubuntu tar -xzf /mnt/flash-pkg/flash-android.tar.gz -C "$APP" \
    --exclude='flash-signals-angular/data' --exclude='Cursor Trading/live'
else
  step "Extrayendo en $APP"
  in_ubuntu mkdir -p "$APP"
  in_ubuntu tar -xzf /mnt/flash-pkg/flash-android.tar.gz -C "$APP"
fi

step "Dependencias de Ubuntu (Python, Node, npm)"
in_ubuntu env SKIP_NEURAL="${SKIP_NEURAL:-0}" WITH_OCR="${WITH_OCR:-0}" bash "$APP/setup-ubuntu.sh"

step "Scripts de arranque"
# Túnel SSH al PC con MT5 (corre en Termux, no en proot; comparten 127.0.0.1)
in_ubuntu cat "$APP/flash-signals-angular/android/flash-mt5-tunnel.sh" > "$HOME/flash-mt5-tunnel.sh"
chmod +x "$HOME/flash-mt5-tunnel.sh"
TUNNEL_CMD="[ -f ~/.flash-mt5.env ] && ! pgrep -f 'flash-mt5-tunne[l].sh' >/dev/null && (nohup bash ~/flash-mt5-tunnel.sh >~/flash-mt5-tunnel.log 2>&1 &)"

cat > "$HOME/flash-start.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Arranca Flash Signals y abre el navegador en http://localhost:3847
termux-wake-lock
$TUNNEL_CMD
(sleep 8 && termux-open-url http://localhost:3847) &
proot-distro login $DISTRO -- bash $APP/start.sh
EOF
chmod +x "$HOME/flash-start.sh"

# Lo usa el APK Flash Signals (RUN_COMMAND en segundo plano, salida en ~/flash-server.log)
cat > "$HOME/flash-server.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
$TUNNEL_CMD
pgrep -f 'server/inde[x].js' >/dev/null && exit 0
termux-wake-lock
exec proot-distro login $DISTRO -- bash $APP/start.sh
EOF
chmod +x "$HOME/flash-server.sh"

# MT5 sin PC (MetaApi): guarda $APP/metaapi.env, que start.sh usa para arrancar el puente local
cat > "$HOME/flash-metaapi.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
DISTRO=$DISTRO
APP=$APP
EOF
cat >> "$HOME/flash-metaapi.sh" <<'EOF'
# Configura MetaApi para operar MT5 sin PC. Después reinicia Flash Signals.
set -euo pipefail
echo "Datos en app.metaapi.cloud: token (API access) e id de la cuenta MT5 añadida."
read -rsp "METAAPI_TOKEN: " token; echo
read -rp "Id de la cuenta (METAAPI_ACCOUNT_ID): " account
read -rp "Región de la cuenta [new-york]: " region
read -rp "Token del puente (el mismo de Configuración; vacío = sin token): " bridge
read -rp "¿Es una cuenta REAL? Escribe REAL para permitirla (vacío = solo demo): " real
umask 077
tmp=$(mktemp)
printf 'METAAPI_TOKEN=%q\nMETAAPI_ACCOUNT_ID=%q\nMETAAPI_REGION=%q\nMT5_BRIDGE_TOKEN=%q\nMT5_ALLOW_REAL=%q\n' \
  "$token" "$account" "${region:-new-york}" "$bridge" "$([[ "$real" == REAL ]] && echo 1 || echo 0)" > "$tmp"
proot-distro login "$DISTRO" --bind "$tmp:/tmp/flash-metaapi.env" -- \
  install -m 600 /tmp/flash-metaapi.env "$APP/metaapi.env"
rm -f "$tmp"
echo "Guardado en $APP/metaapi.env. Reinicia Flash Signals (Detener → Iniciar y abrir)."
EOF
chmod +x "$HOME/flash-metaapi.sh"

# Ícono para Termux:Widget (opcional)
mkdir -p "$HOME/.shortcuts"
cp -f "$HOME/flash-start.sh" "$HOME/.shortcuts/Flash Signals"
chmod +x "$HOME/.shortcuts/Flash Signals"

rm -f "$PKG_FILE" "$PKG_FILE.part"
VERSION="$(in_ubuntu cat "$APP/VERSION" 2>/dev/null | tr -d '\r\n' || true)"
printf '%s\n' "$VERSION" > "$HOME/.flash-version"
echo ok > "$STATE_FILE"
trap - ERR

echo ""
echo "Instalación completa${VERSION:+ (v$VERSION)}."
echo "  App:       vuelve a Flash Signals: arranca sola"
echo "  Arrancar:  ~/flash-start.sh   (o widget 'Flash Signals')"
echo "  Abrir:     http://localhost:3847 en Chrome"
echo "  Detener:   botón 'Detener servidor' en la app"
echo "  MT5 sin PC: ~/flash-metaapi.sh            (una vez; cuenta MT5 vía MetaApi)"
echo "  MT5 con PC: ~/flash-mt5-tunnel.sh --setup (alternativa: túnel al PC con MetaTrader 5)"
