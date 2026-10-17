#!/usr/bin/env bash
# =============================================================================
# start.sh — API + UI de Flash Signals en Android (dentro de Ubuntu proot)
# =============================================================================
# Express sirve dist/ y /api en http://localhost:3847.
# Señales vía bash (scripts/analyze/analyze.sh).
# Sin puente MT5: en Android ese servicio no existe. Las capturas salen de Yahoo.
# =============================================================================
set -euo pipefail

APP=/opt/flash
export CURSOR_TRADING_ROOT="$APP/Cursor Trading"
export PYTHON="$APP/venv/bin/python"
export PATH="$APP/venv/bin:$PATH"
export SIGNAL_RUNNER=bash
export SERVE_WEB=1
export PORT="${PORT:-3847}"
export BIND_HOST="${BIND_HOST:-127.0.0.1}"
export MPLBACKEND=Agg
export MPLCONFIGDIR="$APP/mplconfig"
mkdir -p "$MPLCONFIGDIR"
export PYTHONIOENCODING=utf-8
# Android no tiene servicio MT5. Capturas, velas y métricas salen de Yahoo
# (y de otro sitio libre si Yahoo no trae un precio real). No arrancar el puente.
export FS_DATA_SOURCE=yahoo
export FS_DISABLE_MT5=1

cd "$APP/flash-signals-angular"

echo "Flash Signals → http://localhost:$PORT  (Ctrl+C para detener)"
exec node server/index.js
