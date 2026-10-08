#!/usr/bin/env bash
# =============================================================================
# setup-ubuntu.sh — dependencias dentro de Ubuntu proot (lo llama termux-install.sh)
# =============================================================================
# Python venv (versiones fijadas desde el PC) + Node 22 + npm del server.
# Variables: SKIP_NEURAL=1 (sin torch)  WITH_OCR=1 (onnxruntime + rapidocr)
# =============================================================================
set -euo pipefail

APP=/opt/flash
TRADING="$APP/Cursor Trading"
WEB="$APP/flash-signals-angular"
VENV="$APP/venv"
export DEBIAN_FRONTEND=noninteractive

echo ">> apt: python3, venv, curl, tzdata..."
apt-get update
apt-get install -y python3 python3-venv python3-pip curl ca-certificates gnupg tzdata

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo ">> Node.js 22 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "   node $(node --version)  npm $(npm --version)"

echo ">> Python venv en $VENV..."
[[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip wheel
"$VENV/bin/pip" install -r "$APP/requirements-android.txt"

if [[ "${SKIP_NEURAL:-0}" != "1" ]]; then
  echo ">> torch / torchvision (Neural, ~600 MB)..."
  "$VENV/bin/pip" install -r "$APP/requirements-android-neural.txt" \
    || echo "[warn] torch no se instaló: -Neural no estará disponible (reintenta con: $VENV/bin/pip install torch torchvision)"
fi

if [[ "${WITH_OCR:-0}" == "1" ]]; then
  echo ">> OCR (onnxruntime + rapidocr)..."
  "$VENV/bin/pip" install -r "$APP/requirements-android-ocr.txt" || echo "[warn] OCR no se instaló"
fi

echo ">> npm del server..."
cd "$WEB/server"
# better-sqlite3 trae binario linux-arm64; si falla, --ignore-scripts deja el fallback sql.js
npm ci --omit=dev || npm ci --omit=dev --ignore-scripts

find "$APP" -maxdepth 4 \( -name '*.sh' -o -name '*.bash' \) -type f -exec sed -i 's/\r$//' {} +
chmod +x "$APP"/*.sh "$TRADING/scripts/analyze/analyze.sh"

echo ">> Verificando modelos ML..."
cd "$TRADING"
"$VENV/bin/python" - <<'PY'
import glob, joblib, sklearn, numpy, pandas
print(f"   sklearn {sklearn.__version__}  numpy {numpy.__version__}  pandas {pandas.__version__}")
for path in sorted(glob.glob("models/*.joblib")):
    joblib.load(path)
    print(f"   OK {path}")
PY

echo ""
echo "Ubuntu listo. Arranque: bash $APP/start.sh"
