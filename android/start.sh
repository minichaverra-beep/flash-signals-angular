#!/usr/bin/env bash
# =============================================================================
# start.sh — API + UI de Flash Signals en Android (dentro de Ubuntu proot)
# =============================================================================
# Express sirve dist/ y /api en http://localhost:3847.
# Señales vía bash (scripts/analyze/analyze.sh).
# MT5 sin PC: si existe $APP/metaapi.env (~/flash-metaapi.sh en Termux) arranca el puente
# mt5-bridge con MT5_BACKEND=metaapi en 127.0.0.1:8765. Con PC: ~/flash-mt5-tunnel.sh.
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

METAAPI_ENV="$APP/metaapi.env"
if [[ -f "$METAAPI_ENV" ]]; then
  pkill -f 'mt5-bridge/bridge.py' 2>/dev/null || true
  (
    set -a
    # shellcheck source=/dev/null
    source "$METAAPI_ENV"
    set +a
    export MT5_BACKEND=metaapi
    exec "$PYTHON" mt5-bridge/bridge.py
  ) >"$APP/mt5-bridge.log" 2>&1 &
  echo "MT5 (MetaApi) → puente en 127.0.0.1:${MT5_BRIDGE_PORT:-8765}  (log: $APP/mt5-bridge.log)"
fi

echo "Flash Signals → http://localhost:$PORT  (Ctrl+C para detener)"
exec node server/index.js
