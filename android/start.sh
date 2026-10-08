#!/usr/bin/env bash
# =============================================================================
# start.sh — API + UI de Flash Signals en Android (dentro de Ubuntu proot)
# =============================================================================
# Un solo proceso: Express sirve dist/ y /api en http://localhost:3847.
# Señales vía bash (scripts/analyze/analyze.sh). Sin MT5 (solo Windows).
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
export PYTHONIOENCODING=utf-8

cd "$APP/flash-signals-angular"
echo "Flash Signals → http://localhost:$PORT  (Ctrl+C para detener)"
exec node server/index.js
