#!/usr/bin/env bash
# =============================================================================
# setup-ubuntu.sh — dependencias dentro de Ubuntu proot (lo llama termux-install.sh)
# =============================================================================
# Python venv (versiones fijadas desde el PC) + Node 22 + npm del server.
# Idempotente: apt, pip y npm solo se ejecutan si falta algo o cambiaron requirements / package-lock.
# Variables: SKIP_NEURAL=1 (sin torch)  WITH_OCR=1 (onnxruntime + rapidocr)  FORCE_DEPS=1 (reinstalar todo)
# =============================================================================
set -euo pipefail

APP=/opt/flash
TRADING="$APP/Cursor Trading"
WEB="$APP/flash-signals-angular"
VENV="$APP/venv"
export DEBIAN_FRONTEND=noninteractive

# unchanged <stamp> <archivos...>: true si el hash guardado coincide con el de los archivos
deps_hash() { cat "$@" 2>/dev/null | sha256sum | cut -d' ' -f1; }
unchanged() {
  local stamp="$1"; shift
  [[ "${FORCE_DEPS:-0}" != "1" && -f "$stamp" && "$(cat "$stamp")" == "$(deps_hash "$@")" ]]
}

APT_PKGS=(python3 python3-venv python3-pip curl ca-certificates gnupg tzdata)
if dpkg -s "${APT_PKGS[@]}" >/dev/null 2>&1; then
  echo ">> apt: ya instalado"
else
  echo ">> apt: python3, venv, curl, tzdata..."
  apt-get update
  apt-get install -y "${APT_PKGS[@]}"
fi

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo ">> Node.js 22 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "   node $(node --version)  npm $(npm --version)"

echo ">> Python venv en $VENV..."
[[ -x "$VENV/bin/python" ]] || python3 -m venv "$VENV"
PIP_STAMP="$VENV/.flash-requirements.sha256"
if unchanged "$PIP_STAMP" "$APP/requirements-android.txt"; then
  echo "   requirements sin cambios"
else
  "$VENV/bin/python" -m pip install --upgrade pip wheel
  "$VENV/bin/pip" install -r "$APP/requirements-android.txt"
  deps_hash "$APP/requirements-android.txt" > "$PIP_STAMP"
fi

if [[ "${SKIP_NEURAL:-0}" != "1" ]]; then
  NEURAL_STAMP="$VENV/.flash-neural.sha256"
  if unchanged "$NEURAL_STAMP" "$APP/requirements-android-neural.txt"; then
    echo "   torch sin cambios"
  else
    echo ">> torch / torchvision (Neural, ~600 MB)..."
    if "$VENV/bin/pip" install -r "$APP/requirements-android-neural.txt"; then
      deps_hash "$APP/requirements-android-neural.txt" > "$NEURAL_STAMP"
    else
      echo "[warn] torch no se instaló: -Neural no estará disponible (reintenta con: $VENV/bin/pip install torch torchvision)"
    fi
  fi
fi

if [[ "${WITH_OCR:-0}" == "1" ]]; then
  OCR_STAMP="$VENV/.flash-ocr.sha256"
  if ! unchanged "$OCR_STAMP" "$APP/requirements-android-ocr.txt"; then
    echo ">> OCR (onnxruntime + rapidocr)..."
    if "$VENV/bin/pip" install -r "$APP/requirements-android-ocr.txt"; then
      deps_hash "$APP/requirements-android-ocr.txt" > "$OCR_STAMP"
    else
      echo "[warn] OCR no se instaló"
    fi
  fi
fi

echo ">> npm del server..."
cd "$WEB/server"
NPM_STAMP="node_modules/.flash-lock.sha256"
if [[ -d node_modules ]] && unchanged "$NPM_STAMP" package.json package-lock.json; then
  echo "   package-lock sin cambios"
else
  # better-sqlite3 trae binario linux-arm64; si falla, --ignore-scripts deja el fallback sql.js
  npm ci --omit=dev || npm ci --omit=dev --ignore-scripts
  deps_hash package.json package-lock.json > "$NPM_STAMP"
fi

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
