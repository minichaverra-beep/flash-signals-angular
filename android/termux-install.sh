#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# termux-install.sh — instala / actualiza Flash Signals en Android (Termux)
# =============================================================================
# Uso (en Termux):
#   bash /sdcard/Download/termux-install.sh            # instala o actualiza
#   bash /sdcard/Download/termux-install.sh --fresh    # reinstala pisando historial
#
# Requiere en Download/: flash-android.tar.gz (generado por pack-for-android.ps1)
# Actualizar conserva flash-signals-angular/data (historial SQLite) y Cursor Trading/live.
# Variables opcionales: BUNDLE=/ruta/flash-android.tar.gz  SKIP_NEURAL=1  WITH_OCR=1
# =============================================================================
set -euo pipefail

FRESH=0
[[ "${1:-}" == "--fresh" ]] && FRESH=1

DISTRO=ubuntu
APP=/opt/flash
PKG_DIR="$HOME/flash-pkg"

if ! ls /sdcard/Download >/dev/null 2>&1; then
  echo ">> Concede el permiso de almacenamiento en el diálogo de Android..."
  termux-setup-storage
  for _ in $(seq 1 120); do
    ls /sdcard/Download >/dev/null 2>&1 && break
    sleep 1
  done
fi

BUNDLE="${BUNDLE:-}"
if [[ -z "$BUNDLE" ]]; then
  for cand in /sdcard/Download/flash-android.tar.gz /sdcard/Download/FlashSignals/flash-android.tar.gz; do
    [[ -f "$cand" ]] && BUNDLE="$cand" && break
  done
fi
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || { echo "ERROR: no encuentro flash-android.tar.gz en Download/" >&2; exit 1; }

echo ">> Paquetes Termux (proot-distro)..."
pkg update -y
pkg install -y proot-distro openssh curl

if ! proot-distro login "$DISTRO" -- true 2>/dev/null; then
  echo ">> Instalando Ubuntu (proot)..."
  proot-distro install "$DISTRO"
fi

mkdir -p "$PKG_DIR"
echo ">> Copiando paquete ($(du -h "$BUNDLE" | cut -f1))..."
cp -f "$BUNDLE" "$PKG_DIR/flash-android.tar.gz"

in_ubuntu() {
  proot-distro login "$DISTRO" --bind "$PKG_DIR:/mnt/flash-pkg" -- "$@"
}

if (( FRESH )); then
  in_ubuntu rm -rf "$APP"
fi

if in_ubuntu test -d "$APP/flash-signals-angular"; then
  echo ">> Actualizando (se conservan historial y live/)..."
  in_ubuntu tar -xzf /mnt/flash-pkg/flash-android.tar.gz -C "$APP" \
    --exclude='flash-signals-angular/data' --exclude='Cursor Trading/live'
else
  echo ">> Extrayendo en $APP..."
  in_ubuntu mkdir -p "$APP"
  in_ubuntu tar -xzf /mnt/flash-pkg/flash-android.tar.gz -C "$APP"
fi

in_ubuntu env SKIP_NEURAL="${SKIP_NEURAL:-0}" WITH_OCR="${WITH_OCR:-0}" bash "$APP/setup-ubuntu.sh"

# Túnel SSH al PC con MT5 (corre en Termux, no en proot; comparten 127.0.0.1)
in_ubuntu cat "$APP/flash-signals-angular/android/flash-mt5-tunnel.sh" > "$HOME/flash-mt5-tunnel.sh"
chmod +x "$HOME/flash-mt5-tunnel.sh"
TUNNEL_CMD="[ -f ~/.flash-mt5.env ] && ! pgrep -f flash-mt5-tunnel.sh >/dev/null && (nohup bash ~/flash-mt5-tunnel.sh >~/flash-mt5-tunnel.log 2>&1 &)"

cat > "$HOME/flash-start.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Arranca Flash Signals y abre el navegador en http://localhost:3847
termux-wake-lock
$TUNNEL_CMD
(sleep 8 && termux-open-url http://localhost:3847) &
proot-distro login $DISTRO -- bash $APP/start.sh
EOF
chmod +x "$HOME/flash-start.sh"

# Lo usa el APK Flash Signals (RUN_COMMAND en segundo plano): sin abrir navegador
cat > "$HOME/flash-server.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
$TUNNEL_CMD
pgrep -f 'server/index.js' >/dev/null && exit 0
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

rm -f "$PKG_DIR/flash-android.tar.gz"

echo ""
echo "Instalación completa."
echo "  App:       abre Flash Signals y pulsa 'Iniciar y abrir'"
echo "  Arrancar:  ~/flash-start.sh   (o widget 'Flash Signals')"
echo "  Abrir:     http://localhost:3847 en Chrome"
echo "  Detener:   Ctrl+C en Termux"
echo "  MT5 sin PC: ~/flash-metaapi.sh            (una vez; cuenta MT5 vía MetaApi)"
echo "  MT5 con PC: ~/flash-mt5-tunnel.sh --setup (alternativa: túnel al PC con MetaTrader 5)"
