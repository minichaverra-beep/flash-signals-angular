"""
Puente local MT5 para Flash Signals API (Node).

Recibe un plan (side, entry, sl, tp) y lo ejecuta en el terminal MetaTrader 5
abierto en este mismo Windows:
  - precio del broker en/mejor que la entrada óptima -> orden a mercado
  - precio todavía no llega a la entrada            -> orden LIMIT en la entrada
SL y TP siempre van adjuntos a la orden.

Solo escucha en 127.0.0.1. Cuentas REAL bloqueadas salvo MT5_ALLOW_REAL=1.

MT5_BACKEND=metaapi usa metaapi_mt5 (MetaApi en la nube) en lugar del terminal de Windows:
así el puente corre en Android/Linux sin PC.
"""
import ctypes
import json
import math
import os
import tempfile
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

try:
    from ctypes import wintypes
except (ImportError, ValueError):  # fuera de Windows: solo lo usa la activación de 'Algo Trading'
    wintypes = None

BACKEND = os.environ.get("MT5_BACKEND", "terminal").strip().lower()
if BACKEND == "metaapi":
    import metaapi_mt5 as mt5
else:
    import MetaTrader5 as mt5

HOST = os.environ.get("MT5_BRIDGE_HOST", "127.0.0.1")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
PORT = int(os.environ.get("MT5_BRIDGE_PORT", "8765"))
TOKEN = os.environ.get("MT5_BRIDGE_TOKEN", "")
ALLOW_REAL = os.environ.get("MT5_ALLOW_REAL") == "1"
TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH") or None
MAGIC = int(os.environ.get("MT5_MAGIC", "260901"))
MAX_BODY = 16 * 1024
AUTO_ALGO_TRADING = os.environ.get("MT5_AUTO_ALGO_TRADING", "1") != "0"
MT5_WINDOW_CLASS = "MetaQuotes::MetaTrader::5.00"
WM_COMMAND = 0x0111
ALGO_TRADING_COMMAND = 32851
ALGO_MUTEX_NAME = "Local\\FlashSignalsMt5AlgoTrading"
ALGO_TOGGLE_STAMP = os.path.join(tempfile.gettempdir(), "flash-signals-mt5-algo-toggle.stamp")
ALGO_TOGGLE_COOLDOWN = 30.0

OK_RETCODES = {
    mt5.TRADE_RETCODE_DONE,
    mt5.TRADE_RETCODE_PLACED,
    mt5.TRADE_RETCODE_DONE_PARTIAL,
}


class BridgeError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


def ensure_connected():
    if mt5.terminal_info() is not None:
        return
    kwargs = {}
    login = os.environ.get("MT5_LOGIN")
    if login:
        kwargs = {
            "login": int(login),
            "password": os.environ.get("MT5_PASSWORD", ""),
            "server": os.environ.get("MT5_SERVER", ""),
        }
    ok = mt5.initialize(TERMINAL_PATH, **kwargs) if TERMINAL_PATH else mt5.initialize(**kwargs)
    if not ok:
        raise BridgeError(503, f"No se pudo conectar al terminal MT5: {mt5.last_error()}")
    acc = mt5.account_info()
    if acc is not None and (acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO or ALLOW_REAL):
        ensure_algo_trading()


def _trade_allowed():
    term = mt5.terminal_info()
    return bool(term and term.trade_allowed)


def _wait_trade_allowed(timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _trade_allowed():
            return True
        time.sleep(0.2)
    return _trade_allowed()


def _process_image(pid):
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        ok = kernel32.QueryFullProcessImageNameW(wintypes.HANDLE(handle), 0, buf, ctypes.byref(size))
        return buf.value if ok else ""
    finally:
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def _terminal_windows():
    """Ventanas principales de MT5 como [(hwnd, ruta del exe)]."""
    user32 = ctypes.windll.user32
    found = []

    def collect(hwnd, _lparam):
        cls = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, cls, 64)
        if cls.value == MT5_WINDOW_CLASS:
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            found.append((hwnd, _process_image(pid.value)))
        return True

    callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(collect)
    user32.EnumWindows(callback, 0)
    return found


def _terminal_window(term):
    windows = _terminal_windows()
    folder = os.path.normcase(os.path.normpath(term.path or ""))
    for hwnd, exe in windows:
        if exe and os.path.normcase(os.path.dirname(exe)) == folder:
            return hwnd
    return windows[0][0] if len(windows) == 1 else None


@contextmanager
def _algo_toggle_lock():
    """Mutex con nombre compartido por los puentes: solo uno conmuta a la vez."""
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    handle = wintypes.HANDLE(kernel32.CreateMutexW(None, False, ALGO_MUTEX_NAME))
    if not handle.value:
        yield False
        return
    acquired = kernel32.WaitForSingleObject(handle, 10000) in (0, 0x80)
    try:
        yield acquired
    finally:
        if acquired:
            kernel32.ReleaseMutex(handle)
        kernel32.CloseHandle(handle)


def _recent_toggle():
    try:
        return time.time() - os.path.getmtime(ALGO_TOGGLE_STAMP) < ALGO_TOGGLE_COOLDOWN
    except OSError:
        return False


def _toggle_algo_trading():
    """El comando es un toggle: solo se envía con el mutex tomado y tras re-comprobar que está apagado."""
    term = mt5.terminal_info()
    if term is None or term.trade_allowed or term.tradeapi_disabled:
        return bool(term and term.trade_allowed)
    if _recent_toggle():
        return _wait_trade_allowed()
    hwnd = _terminal_window(term)
    if not hwnd:
        print("[mt5-bridge] No se encontró la ventana del terminal MT5 para activar 'Algo Trading'.")
        return False
    with open(ALGO_TOGGLE_STAMP, "w", encoding="utf-8") as stamp:
        stamp.write(str(os.getpid()))
    user32 = ctypes.windll.user32
    user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
    if not user32.PostMessageW(hwnd, WM_COMMAND, ALGO_TRADING_COMMAND, 0):
        return False
    enabled = _wait_trade_allowed()
    print(f"[mt5-bridge] 'Algo Trading' {'activado automáticamente' if enabled else 'no se pudo activar'}.")
    return enabled


def ensure_algo_trading():
    """Activa 'Algo Trading' si está apagado (MT5_AUTO_ALGO_TRADING=0 lo desactiva). True si queda activo."""
    if _trade_allowed():
        return True
    if not AUTO_ALGO_TRADING or os.name != "nt":
        return False
    with _algo_toggle_lock() as locked:
        if not locked:
            return _trade_allowed()
        return _toggle_algo_trading()


def account_guard():
    ensure_connected()
    acc = mt5.account_info()
    if acc is None:
        raise BridgeError(503, f"MT5 sin cuenta conectada: {mt5.last_error()}")
    is_demo = acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO
    if not is_demo and not ALLOW_REAL:
        raise BridgeError(403, "Cuenta REAL bloqueada. Define MT5_ALLOW_REAL=1 si de verdad quieres operar en real.")
    if not ensure_algo_trading():
        if BACKEND == "metaapi":
            raise BridgeError(409, "MetaApi indica que la cuenta no puede operar (¿añadida con contraseña de inversor?).")
        term = mt5.terminal_info()
        if term is not None and term.tradeapi_disabled:
            raise BridgeError(409, "MT5 tiene desactivado el trading por la API de Python (Opciones > Asesores Expertos).")
        raise BridgeError(409, "Activa 'Algo Trading' en el terminal MT5.")
    return acc, is_demo


def health():
    ensure_connected()
    acc = mt5.account_info()
    term = mt5.terminal_info()
    return {
        "ok": True,
        "connected": bool(term and term.connected),
        "tradeAllowed": bool(term and term.trade_allowed),
        "tradeApiDisabled": bool(term and term.tradeapi_disabled),
        "accountTradeExpert": None if acc is None else bool(acc.trade_expert),
        "autoAlgoTrading": AUTO_ALGO_TRADING,
        "account": None if acc is None else {
            "login": acc.login,
            "server": acc.server,
            "demo": acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO,
            "currency": acc.currency,
            "balance": acc.balance,
            "equity": acc.equity,
        },
        "allowReal": ALLOW_REAL,
        "magic": MAGIC,
        "backend": BACKEND,
    }


def num(payload, key, required=True):
    raw = payload.get(key)
    if raw is None or raw == "":
        if required:
            raise BridgeError(400, f"Falta '{key}'")
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise BridgeError(400, f"'{key}' debe ser numérico") from None
    if not math.isfinite(value) or value <= 0:
        raise BridgeError(400, f"'{key}' debe ser > 0")
    return value


def step_decimals(step):
    text = f"{step:.10f}".rstrip("0")
    return len(text.split(".")[1]) if "." in text else 0


def loss_per_lot(symbol, is_long, price, sl):
    order_type = mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL
    loss = mt5.order_calc_profit(order_type, symbol, 1.0, price, sl)
    if loss is None or loss >= 0:
        raise BridgeError(422, f"No se pudo calcular el riesgo por lote: {mt5.last_error()}")
    return abs(loss)


def calc_volume(symbol, info, is_long, price, sl, equity, volume, risk_pct):
    """(lotes, aviso). Bajo el lote mínimo del broker se usa el mínimo y el aviso da el riesgo real."""
    if volume:
        raw = volume
    else:
        raw = (equity * risk_pct / 100.0) / loss_per_lot(symbol, is_long, price, sl)

    step = info.volume_step
    vol = round(math.floor(raw / step + 1e-9) * step, step_decimals(step))
    if vol >= info.volume_min:
        return min(vol, info.volume_max), None
    note = f"Lote calculado {raw:.4f} < mínimo {info.volume_min}: se usa {info.volume_min}"
    if sl:
        risk_usd = loss_per_lot(symbol, is_long, price, sl) * info.volume_min
        risk_real = risk_usd / equity * 100.0 if equity else 0.0
        note += f" (riesgo real {risk_real:.2f} % = {risk_usd:.2f} {account_currency()}"
        note += f" en vez de {risk_pct:g} %)" if not volume else ")"
    return info.volume_min, note


def local_day_start():
    """Epoch UTC de las 00:00 locales de hoy (el día de trading es el del PC)."""
    lt = time.localtime()
    return int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)))


def daily_limits_guard(acc, max_trades, max_dd_pct):
    """Operaciones de hoy (entradas con nuestro magic + pendientes vivas) y drawdown de hoy de la cuenta."""
    if not max_trades and not max_dd_pct:
        return
    offset, _ = server_offset()
    day_from = local_day_start() + offset
    deals = mt5.history_deals_get(day_from, int(time.time()) + offset + DEALS_MARGIN_SEC)
    if deals is None:
        raise BridgeError(502, f"history_deals_get falló: {mt5.last_error()}")
    deals = [d for d in deals if d.time >= day_from and d.type in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL)]

    if max_trades:
        entries = sum(1 for d in deals if d.magic == MAGIC and d.entry == mt5.DEAL_ENTRY_IN)
        pending = sum(1 for o in (mt5.orders_get() or ()) if o.magic == MAGIC and o.time_setup >= day_from)
        if entries + pending >= max_trades:
            raise BridgeError(
                409,
                f"Límite diario alcanzado: {entries + pending} operaciones hoy (máx {max_trades}). "
                "Sube el límite en Configuración o espera a mañana.",
            )

    if max_dd_pct:
        realized = sum(d.profit + d.commission + d.swap + getattr(d, "fee", 0.0) for d in deals)
        floating = acc.equity - acc.balance
        start = acc.balance - realized
        dd_pct = max(0.0, -(realized + floating)) / start * 100.0 if start > 0 else 0.0
        if dd_pct >= max_dd_pct:
            raise BridgeError(
                409,
                f"Drawdown de hoy {dd_pct:.2f} % (máx {max_dd_pct:g} %): no se abren más operaciones hoy.",
            )


def require_margin(symbol, is_long, price, volume):
    """El lote del riesgo configurado nunca se reduce: sin margen libre suficiente la orden no se envía."""
    acc = mt5.account_info()
    order_type = mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL
    needed = mt5.order_calc_margin(order_type, symbol, volume, price)
    if acc is None or not needed or needed <= acc.margin_free:
        return
    raise BridgeError(
        422,
        f"Sin margen para {volume} lotes: necesita {needed:.2f} {account_currency()} y hay {acc.margin_free:.2f} libres. "
        "No se reduce el lote: cierra posiciones/órdenes pendientes o sube el apalancamiento.",
    )


def account_currency():
    acc = mt5.account_info()
    return getattr(acc, "currency", "") or "USD"


def filling_candidates(info):
    preferred = []
    if info.filling_mode & 1:
        preferred.append(mt5.ORDER_FILLING_FOK)
    if info.filling_mode & 2:
        preferred.append(mt5.ORDER_FILLING_IOC)
    preferred.append(mt5.ORDER_FILLING_RETURN)
    return preferred


def send(request, fillings):
    last = None
    for filling in fillings:
        request["type_filling"] = filling
        check = mt5.order_check(request)
        if check is None:
            raise BridgeError(502, f"order_check falló: {mt5.last_error()}")
        if check.retcode not in (0, mt5.TRADE_RETCODE_DONE):
            last = check
            if check.retcode == mt5.TRADE_RETCODE_INVALID_FILL:
                continue
            raise BridgeError(422, f"MT5 rechazó la orden (check): {check.comment}", retcode=check.retcode)
        result = mt5.order_send(request)
        if result is None:
            raise BridgeError(502, f"order_send falló: {mt5.last_error()}")
        if result.retcode == mt5.TRADE_RETCODE_INVALID_FILL:
            last = result
            continue
        return result
    raise BridgeError(422, f"Ningún modo de llenado aceptado por el broker: {last.comment if last else '?'}")


ORDER_MODES = ("auto", "market", "limit", "stop")


def symbol_quote(symbol, require_tradeable=False):
    if not mt5.symbol_select(symbol, True):
        raise BridgeError(404, f"Símbolo '{symbol}' no existe en el broker (revisa MT5_SYMBOL_*).")
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        raise BridgeError(503, f"Sin cotización para {symbol}: {mt5.last_error()}")
    if require_tradeable and info.trade_mode == mt5.SYMBOL_TRADE_MODE_DISABLED:
        raise BridgeError(409, f"{symbol} no permite operar ahora (mercado cerrado o deshabilitado).")
    return info, tick


def as_market(request, info, is_long, deviation):
    """Completa la petición como orden a mercado; devuelve los modos de llenado a probar."""
    request.update(
        action=mt5.TRADE_ACTION_DEAL,
        type=mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL,
        deviation=deviation,
        type_time=mt5.ORDER_TIME_GTC,
    )
    return filling_candidates(info)


def as_pending(request, info, tick, order_type, expiry_minutes):
    """Completa la petición como orden pendiente (con expiración si el broker la admite)."""
    request.update(action=mt5.TRADE_ACTION_PENDING, type=order_type, type_time=mt5.ORDER_TIME_GTC)
    if expiry_minutes > 0 and info.expiration_mode & 4:
        request.update(type_time=mt5.ORDER_TIME_SPECIFIED, expiration=int(tick.time) + expiry_minutes * 60)
    return [mt5.ORDER_FILLING_RETURN]


def in_range(is_long, sl, price, tp):
    return sl < price < tp if is_long else tp < price < sl


def check_signal_market(is_long, entry, sl, tp, market_price, max_dev_pct):
    deviation_pct = abs(market_price - entry) / entry * 100
    if deviation_pct > max_dev_pct:
        raise BridgeError(
            422,
            f"Precio broker {market_price} está a {deviation_pct:.2f}% de la entrada {entry} "
            f"(máx {max_dev_pct}%). Feed de la señal y broker no coinciden.",
        )
    if not in_range(is_long, sl, market_price, tp):
        raise BridgeError(409, f"Precio {market_price} ya fuera del rango SL/TP: señal invalidada o TP alcanzado.")


def account_info(acc, is_demo):
    return {"login": acc.login, "server": acc.server, "demo": is_demo}


def parse_order_mode(payload, manual):
    order_mode = str(payload.get("order_mode") or ("market" if manual else "auto")).lower()
    if order_mode not in ORDER_MODES:
        raise BridgeError(400, f"'order_mode' debe ser {' | '.join(ORDER_MODES)}")
    if not manual and order_mode != "auto":
        raise BridgeError(400, "'order_mode' distinto de auto requiere 'manual'")
    return order_mode


def place_order(payload):
    symbol = str(payload.get("symbol") or "").strip()
    side = str(payload.get("side") or "").upper()
    if not symbol:
        raise BridgeError(400, "Falta 'symbol'")
    if side not in ("LONG", "SHORT"):
        raise BridgeError(400, "'side' debe ser LONG o SHORT")
    # manual: sin chequeos de señal (coherencia, desvío, rango SL/TP); MT5 valida el resto.
    manual = bool(payload.get("manual"))
    order_mode = parse_order_mode(payload, manual)
    if manual:
        return place_manual(payload, symbol, side, order_mode)
    return place_signal(payload, symbol, side)


def limit_value(payload, key):
    """Límite opcional ≥ 0 (0 o ausente = sin límite)."""
    raw = payload.get(key)
    if raw in (None, ""):
        return 0.0
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise BridgeError(400, f"'{key}' debe ser un número ≥ 0") from None
    if not math.isfinite(value) or value < 0:
        raise BridgeError(400, f"'{key}' debe ser un número ≥ 0")
    return value


def order_options(payload):
    """Opciones comunes a orden de señal y manual (con sus valores por defecto)."""
    return {
        "volume": num(payload, "volume", required=False),
        "risk_pct": num(payload, "risk_pct", required=False) or 0.5,
        "deviation": int(num(payload, "deviation_points", required=False) or 20),
        "expiry_minutes": int(payload.get("expiry_minutes") or 0),
        "dry_run": bool(payload.get("dry_run")),
        "max_trades_per_day": int(limit_value(payload, "max_trades_per_day")),
        "max_daily_dd_pct": limit_value(payload, "max_daily_dd_pct"),
        "client_id": str(payload.get("client_id") or "")[:24],
    }


def order_summary(mode, side, request, market_price, entry, acc, is_demo):
    return {
        "mode": mode,
        "symbol": request["symbol"],
        "side": side,
        "volume": request["volume"],
        "price": request["price"],
        "sl": request["sl"] or None,
        "tp": request["tp"] or None,
        "marketPrice": market_price,
        "signalEntry": entry,
        "expiresAt": request.get("expiration"),
        "account": account_info(acc, is_demo),
    }


def signal_uses_market(is_long, entry, market_price, min_dist):
    """A mercado si el precio ya alcanzó la entrada o está a menos del stops level; si no, LIMIT."""
    reached = market_price <= entry if is_long else market_price >= entry
    return reached or abs(market_price - entry) <= min_dist


def place_signal(payload, symbol, side):
    entry = num(payload, "entry")
    sl = num(payload, "sl")
    tp = num(payload, "tp")
    max_dev_pct = num(payload, "max_entry_deviation_pct", required=False) or 1.0
    opts = order_options(payload)

    is_long = side == "LONG"
    if not in_range(is_long, sl, entry, tp):
        raise BridgeError(422, "LONG requiere SL < entry < TP" if is_long else "SHORT requiere TP < entry < SL")

    acc, is_demo = account_guard()
    daily_limits_guard(acc, opts["max_trades_per_day"], opts["max_daily_dd_pct"])
    info, tick = symbol_quote(symbol, require_tradeable=True)

    market_price = tick.ask if is_long else tick.bid
    check_signal_market(is_long, entry, sl, tp, market_price, max_dev_pct)

    min_dist = info.trade_stops_level * info.point
    use_market = signal_uses_market(is_long, entry, market_price, min_dist)
    price = market_price if use_market else entry
    if abs(price - sl) < min_dist or abs(tp - price) < min_dist:
        raise BridgeError(422, f"SL/TP demasiado cerca del precio (stops level {info.trade_stops_level} pts).")

    digits = info.digits
    volume, volume_note = calc_volume(symbol, info, is_long, price, sl, acc.equity, opts["volume"], opts["risk_pct"])
    require_margin(symbol, is_long, price, volume)
    request = {
        "symbol": symbol,
        "volume": volume,
        "price": round(price, digits),
        "sl": round(sl, digits),
        "tp": round(tp, digits),
        "magic": MAGIC,
        "comment": f"FS {opts['client_id']}".strip()[:31],
    }
    if use_market:
        fillings = as_market(request, info, is_long, opts["deviation"])
    else:
        limit_type = mt5.ORDER_TYPE_BUY_LIMIT if is_long else mt5.ORDER_TYPE_SELL_LIMIT
        fillings = as_pending(request, info, tick, limit_type, opts["expiry_minutes"])

    summary = order_summary("market" if use_market else "pending", side, request, market_price, entry, acc, is_demo)
    summary["volumeNote"] = volume_note
    return execute(request, fillings, summary, opts["dry_run"])


def execute(request, fillings, summary, dry_run):
    if dry_run:
        # La vista previa nunca bloquea el envío: el aviso de order_check se muestra y el envío real decide.
        check = None
        for filling in fillings:
            request["type_filling"] = filling
            check = mt5.order_check(request)
            if check is None or check.retcode != mt5.TRADE_RETCODE_INVALID_FILL:
                break
        passed = check is not None and check.retcode in (0, mt5.TRADE_RETCODE_DONE)
        warning = None
        if not passed:
            warning = (
                f"order_check falló: {mt5.last_error()}" if check is None
                else f"MT5 avisa (check {check.retcode}): {check.comment}"
            )
        return {
            "ok": True,
            "dryRun": True,
            "check": None if check is None else {"retcode": check.retcode, "comment": check.comment},
            "checkWarning": warning,
            **summary,
        }

    result = send(request, fillings)
    if result.retcode not in OK_RETCODES:
        raise BridgeError(422, f"MT5 rechazó la orden: {result.comment}", retcode=result.retcode)
    return {
        "ok": True,
        "retcode": result.retcode,
        "comment": result.comment,
        "order": result.order,
        "deal": result.deal,
        **summary,
        "price": result.price or request["price"],
    }


def place_manual(payload, symbol, side, order_mode):
    entry = num(payload, "entry", required=order_mode in ("limit", "stop"))
    sl = num(payload, "sl", required=False)
    tp = num(payload, "tp", required=False)
    opts = order_options(payload)
    if opts["volume"] is None and sl is None:
        raise BridgeError(422, "Sin SL no se puede calcular el riesgo: indica los lotes.")
    is_long = side == "LONG"

    acc, is_demo = account_guard()
    daily_limits_guard(acc, opts["max_trades_per_day"], opts["max_daily_dd_pct"])
    info, tick = symbol_quote(symbol)

    market_price = tick.ask if is_long else tick.bid
    use_market = manual_uses_market(order_mode, is_long, entry, market_price)
    price = market_price if use_market else entry

    digits = info.digits
    volume, volume_note = calc_volume(symbol, info, is_long, price, sl, acc.equity, opts["volume"], opts["risk_pct"])
    require_margin(symbol, is_long, price, volume)
    request = {
        "symbol": symbol,
        "volume": volume,
        "price": round(price, digits),
        "sl": round_or_zero(sl, digits),
        "tp": round_or_zero(tp, digits),
        "magic": MAGIC,
        "comment": f"FS manual {opts['client_id']}".strip()[:31],
    }
    stop = order_mode == "stop"
    if use_market:
        fillings = as_market(request, info, is_long, opts["deviation"])
        mode = "market"
    else:
        fillings = as_pending(request, info, tick, pending_order_type(is_long, stop), opts["expiry_minutes"])
        mode = "stop" if stop else "pending"

    summary = {
        **order_summary(mode, side, request, market_price, entry, acc, is_demo),
        "manual": True,
        "volumeNote": volume_note,
    }
    return execute(request, fillings, summary, opts["dry_run"])

def round_or_zero(value, digits):
    """MT5 usa 0.0 para «sin SL/TP»."""
    return round(value, digits) if value else 0.0


def manual_uses_market(order_mode, is_long, entry, market_price):
    """market siempre; auto a mercado si no hay entrada o el precio ya la alcanzó."""
    if order_mode == "market":
        return True
    if order_mode != "auto":
        return False
    if entry is None:
        return True
    return market_price <= entry if is_long else market_price >= entry


def pending_order_type(is_long, stop):
    if is_long:
        return mt5.ORDER_TYPE_BUY_STOP if stop else mt5.ORDER_TYPE_BUY_LIMIT
    return mt5.ORDER_TYPE_SELL_STOP if stop else mt5.ORDER_TYPE_SELL_LIMIT


CLOSE_REASONS = {
    getattr(mt5, "DEAL_REASON_SL", -1): "sl",
    getattr(mt5, "DEAL_REASON_TP", -2): "tp",
    getattr(mt5, "DEAL_REASON_SO", -3): "stopout",
}


def order_status(payload):
    """Estado real de una orden enviada (ticket): pendiente, abierta, cerrada o cancelada."""
    try:
        ticket = int(payload.get("ticket"))
    except (TypeError, ValueError):
        raise BridgeError(400, "Falta 'ticket' numérico") from None
    if ticket <= 0:
        raise BridgeError(400, "'ticket' debe ser > 0")
    ensure_connected()
    for lookup in (_pending_status, _position_status, _deals_status, _history_status):
        status = lookup(ticket)
        if status is not None:
            return {"ok": True, "ticket": ticket, **status}
    raise BridgeError(404, f"Ticket {ticket} no encontrado en MT5 (¿otra cuenta?).")


def _levels(price, sl, tp):
    return {"entry": price or None, "sl": sl or None, "tp": tp or None}


def _pending_status(ticket):
    pending = mt5.orders_get(ticket=ticket) or ()
    if not pending:
        return None
    o = pending[0]
    return {"state": "pending", "symbol": o.symbol, "volume": o.volume_current,
            **_levels(o.price_open, o.sl, o.tp)}


def _position_status(ticket):
    positions = mt5.positions_get(ticket=ticket) or ()
    if not positions:
        return None
    p = positions[0]
    return {"state": "open", "symbol": p.symbol, "volume": p.volume,
            "profit": round(p.profit + p.swap, 2), "currentPrice": p.price_current,
            **_levels(p.price_open, p.sl, p.tp)}


def _deals_status(ticket):
    deals = list(mt5.history_deals_get(position=ticket) or ())
    if not deals:
        return None
    entry = next((d for d in deals if d.entry == mt5.DEAL_ENTRY_IN), deals[0])
    exits = [d for d in deals if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)]
    hist = mt5.history_orders_get(ticket=ticket) or ()
    sl, tp = (hist[0].sl, hist[0].tp) if hist else (0, 0)
    profit = round(sum(d.profit + d.swap + d.commission for d in deals), 2)
    offset, _source = server_offset()
    base = {"symbol": entry.symbol, "volume": entry.volume, "profit": profit,
            "openTime": entry.time - offset, **_levels(entry.price, sl, tp)}
    if not exits:
        return {"state": "open", **base}
    last = exits[-1]
    return {"state": "closed", **base, "closePrice": last.price, "closeTime": last.time - offset,
            "closeReason": CLOSE_REASONS.get(last.reason, "manual")}


def _history_status(ticket):
    hist = mt5.history_orders_get(ticket=ticket) or ()
    if not hist:
        return None
    o = hist[0]
    state = "expired" if o.state == mt5.ORDER_STATE_EXPIRED else "canceled"
    return {"state": state, "symbol": o.symbol, "volume": o.volume_initial,
            **_levels(o.price_open, o.sl, o.tp)}


OFFSET_STEP_SEC = 1800
MAX_TICK_LAG_SEC = 120
MAX_OFFSET_SEC = 14 * 3600
DEALS_MARGIN_SEC = 86400
MAX_DEALS_RANGE_SEC = 62 * 86400


def estimate_offset(server_ts, utc_now):
    """Desfase hora servidor − UTC (múltiplo de 30 min) desde un tick reciente; None si el tick está viejo."""
    raw = server_ts - utc_now
    offset = round(raw / OFFSET_STEP_SEC) * OFFSET_STEP_SEC
    if abs(raw - offset) > MAX_TICK_LAG_SEC or abs(offset) > MAX_OFFSET_SEC:
        return None
    return int(offset)


def server_offset():
    """Las horas de los deals MT5 vienen en hora del servidor: desfase desde el tick más reciente de Market Watch."""
    env = os.environ.get("MT5_SERVER_UTC_OFFSET_SEC")
    if env:
        return int(env), "env"
    latest = 0
    for s in mt5.symbols_get() or ():
        if not s.visible:
            continue
        tick = mt5.symbol_info_tick(s.name)
        if tick is not None and tick.time > latest:
            latest = tick.time
    offset = estimate_offset(latest, time.time()) if latest else None
    return (offset, "tick") if offset is not None else (0, "default")


def deal_to_dict(d, offset):
    return {
        "ticket": d.ticket,
        "position": d.position_id,
        "symbol": d.symbol,
        "type": "BUY" if d.type == mt5.DEAL_TYPE_BUY else "SELL",
        "entry": {mt5.DEAL_ENTRY_IN: "in", mt5.DEAL_ENTRY_OUT: "out", mt5.DEAL_ENTRY_OUT_BY: "out"}.get(d.entry, "inout"),
        "volume": d.volume,
        "price": d.price,
        "profit": d.profit,
        "commission": d.commission,
        "swap": d.swap,
        "fee": getattr(d, "fee", 0.0),
        "time": d.time - offset,
        "magic": d.magic,
        "comment": d.comment,
    }


def history_deals(payload):
    """Deals de compra/venta de un símbolo en [from, to] (epoch UTC, s); horas devueltas en UTC."""
    symbol = str(payload.get("symbol") or "").strip()
    if not symbol:
        raise BridgeError(400, "Falta 'symbol'")
    try:
        date_from = int(payload.get("from"))
        date_to = int(payload.get("to") or time.time())
    except (TypeError, ValueError):
        raise BridgeError(400, "'from' y 'to' deben ser epoch en segundos") from None
    if date_to <= date_from or date_to - date_from > MAX_DEALS_RANGE_SEC:
        raise BridgeError(400, "Rango 'from'/'to' inválido (máx 62 días)")
    ensure_connected()
    acc = mt5.account_info()
    if acc is None:
        raise BridgeError(503, f"MT5 sin cuenta conectada: {mt5.last_error()}")
    offset, offset_source = server_offset()
    deals = mt5.history_deals_get(date_from + offset - DEALS_MARGIN_SEC, date_to + offset + DEALS_MARGIN_SEC)
    if deals is None:
        raise BridgeError(502, f"history_deals_get falló: {mt5.last_error()}")
    trade_types = (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL)
    rows = [
        deal_to_dict(d, offset)
        for d in deals
        if d.symbol.upper() == symbol.upper() and d.type in trade_types
    ]
    rows = [r for r in rows if date_from <= r["time"] <= date_to]
    return {
        "ok": True,
        "account": account_info(acc, acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO),
        "serverOffsetSec": offset,
        "offsetSource": offset_source,
        "deals": rows,
        "positions": {str(pid): opening_levels(pid) for pid in {r["position"] for r in rows if r["position"]}},
    }


TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
}
MAX_RATES = 5000


def rate_to_dict(r, offset):
    return {
        "time": int(r["time"]) - offset,
        "open": float(r["open"]),
        "high": float(r["high"]),
        "low": float(r["low"]),
        "close": float(r["close"]),
        "volume": int(r["tick_volume"]),
    }


def parse_rates_request(payload):
    symbol = str(payload.get("symbol") or "").strip()
    if not symbol:
        raise BridgeError(400, "Falta 'symbol'")
    tf_name = str(payload.get("timeframe") or "M5").upper()
    if tf_name not in TIMEFRAMES:
        raise BridgeError(400, f"'timeframe' debe ser {' | '.join(TIMEFRAMES)}")
    try:
        count = int(payload["count"]) if payload.get("count") not in (None, "") else 200
        to = int(payload["to"]) if payload.get("to") not in (None, "") else None
    except (TypeError, ValueError):
        raise BridgeError(400, "'count' y 'to' deben ser enteros (to = epoch UTC en segundos)") from None
    if not 1 <= count <= MAX_RATES:
        raise BridgeError(400, f"'count' debe estar entre 1 y {MAX_RATES}")
    return symbol, tf_name, count, to


def market_rates(payload):
    """Velas OHLC (bid) de un símbolo, solo lectura; horas en UTC. Con 'to': última vela ≤ to."""
    symbol, tf_name, count, to = parse_rates_request(payload)
    ensure_connected()
    info, tick = symbol_quote(symbol)
    offset, offset_source = server_offset()
    if to is None:
        rates = mt5.copy_rates_from_pos(symbol, TIMEFRAMES[tf_name], 0, count)
    else:
        rates = mt5.copy_rates_from(symbol, TIMEFRAMES[tf_name], to + offset, count)
    if rates is None:
        raise BridgeError(502, f"copy_rates falló para {symbol}: {mt5.last_error()}")
    return {
        "ok": True,
        "symbol": symbol,
        "timeframe": tf_name,
        "digits": info.digits,
        "serverOffsetSec": offset,
        "offsetSource": offset_source,
        "bid": tick.bid,
        "ask": tick.ask,
        "tickTime": int(tick.time) - offset,
        "rates": [rate_to_dict(r, offset) for r in rates],
    }


def search_symbols(query):
    """Símbolos del broker cuyo nombre o descripción contiene `query` (solo lectura)."""
    text = str(query or "").strip().upper()
    if not 2 <= len(text) <= 32:
        raise BridgeError(400, "'query' debe tener entre 2 y 32 caracteres")
    ensure_connected()
    found = [
        s for s in (mt5.symbols_get() or ())
        if text in s.name.upper() or text in (s.description or "").upper()
    ]
    return {
        "ok": True,
        "query": text,
        "symbols": [
            {"name": s.name, "description": s.description, "path": s.path, "visible": bool(s.visible)}
            for s in found[:50]
        ],
    }


def symbol_details(name):
    """Ficha de un símbolo para calcular lotes y dinero por punto (solo lectura)."""
    symbol = str(name or "").strip()
    if not symbol:
        raise BridgeError(400, "Falta 'name'")
    ensure_connected()
    info, tick = symbol_quote(symbol)
    return {
        "ok": True,
        "symbol": symbol,
        "digits": info.digits,
        "point": info.point,
        "tickSize": info.trade_tick_size,
        "tickValue": getattr(info, "trade_tick_value_loss", 0.0) or info.trade_tick_value,
        "contractSize": info.trade_contract_size,
        "volumeMin": info.volume_min,
        "volumeMax": info.volume_max,
        "volumeStep": info.volume_step,
        "stopsLevel": info.trade_stops_level,
        "currency": account_currency(),
        "bid": tick.bid,
        "ask": tick.ask,
    }


def opening_levels(position_id):
    """SL/TP con que se abrió la posición (orden de apertura); None si no constan."""
    orders = sorted(mt5.history_orders_get(position=position_id) or (), key=lambda o: o.time_setup)
    if not orders:
        return {"sl": None, "tp": None}
    first = orders[0]
    return {"sl": first.sl or None, "tp": first.tp or None}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body):
        data = json.dumps(body, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        if TOKEN and self.headers.get("X-Bridge-Token") != TOKEN:
            self._send(401, {"ok": False, "error": "Token inválido"})
            return False
        return True

    def _handle(self, fn):
        try:
            self._send(200, fn())
        except BridgeError as err:
            self._send(err.status, {"ok": False, "error": err.message, **err.extra})
        except Exception as err:  # noqa: BLE001
            self._send(500, {"ok": False, "error": f"{type(err).__name__}: {err}"})

    def do_GET(self):
        if not self._authorized():
            return
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if url.path == "/health":
            self._handle(health)
        elif url.path == "/symbols":
            self._handle(lambda: search_symbols((query.get("query") or [""])[0]))
        elif url.path == "/symbol":
            self._handle(lambda: symbol_details((query.get("name") or [""])[0]))
        else:
            self._send(404, {"ok": False, "error": "Ruta no encontrada"})

    def do_POST(self):
        if not self._authorized():
            return
        routes = {"/order": place_order, "/status": order_status, "/deals": history_deals, "/rates": market_rates}
        handler = routes.get(self.path)
        if handler is None:
            self._send(404, {"ok": False, "error": "Ruta no encontrada"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send(400, {"ok": False, "error": "Body vacío o demasiado grande"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            self._send(400, {"ok": False, "error": "JSON inválido"})
            return
        self._handle(lambda: handler(payload))

    def log_message(self, fmt, *args):
        print(f"[mt5-bridge] {self.address_string()} {fmt % args}")


def main():
    try:
        ensure_connected()
        print(f"[mt5-bridge] Conectado a MT5: {health()['account']}")
    except BridgeError as err:
        print(f"[mt5-bridge] Aviso: {err.message} (se reintentará en cada petición)")
    if HOST not in LOOPBACK_HOSTS:
        raise SystemExit(f"[mt5-bridge] MT5_BRIDGE_HOST={HOST!r} no es loopback: el puente no se expone a la red.")
    server = HTTPServer((HOST, PORT), Handler)
    print(f"[mt5-bridge] Escuchando en {HOST}:{PORT} (solo loopback, backend={BACKEND}, magic={MAGIC}, allowReal={ALLOW_REAL})")
    try:
        # HTTP sin TLS aceptable: solo loopback (LOOPBACK_HOSTS).
        server.serve_forever()  # NOSONAR
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
