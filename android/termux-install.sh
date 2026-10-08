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

if [[ ! -d "$HOME/storage" ]]; then
  echo ">> Concede el permiso de almacenamiento en el diálogo de Android..."
  termux-setup-storage
  sleep 5
fi

BUNDLE="${BUNDLE:-}"
if [[ -z "$BUNDLE" ]]; then
  for cand in /sdcard/Download/flash-android.tar.gz "$HOME/storage/downloads/flash-android.tar.gz"; do
    [[ -f "$cand" ]] && BUNDLE="$cand" && break
  done
fi
[[ -n "$BUNDLE" && -f "$BUNDLE" ]] || { echo "ERROR: no encuentro flash-android.tar.gz en Download/" >&2; exit 1; }

echo ">> Paquetes Termux (proot-distro)..."
pkg update -y
pkg install -y proot-distro

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

cat > "$HOME/flash-start.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Arranca Flash Signals y abre el navegador en http://localhost:3847
termux-wake-lock
(sleep 8 && termux-open-url http://localhost:3847) &
proot-distro login $DISTRO -- bash $APP/start.sh
EOF
chmod +x "$HOME/flash-start.sh"

# Ícono para Termux:Widget (opcional)
mkdir -p "$HOME/.shortcuts"
cp -f "$HOME/flash-start.sh" "$HOME/.shortcuts/Flash Signals"
chmod +x "$HOME/.shortcuts/Flash Signals"

rm -f "$PKG_DIR/flash-android.tar.gz"

echo ""
echo "Instalación completa."
echo "  Arrancar:  ~/flash-start.sh   (o widget 'Flash Signals')"
echo "  Abrir:     http://localhost:3847 en Chrome"
echo "  Detener:   Ctrl+C en Termux"
