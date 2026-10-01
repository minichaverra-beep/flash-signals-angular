"""
Puente local MT5 para Flash Signals API (Node).

Recibe un plan (side, entry, sl, tp) y lo ejecuta en el terminal MetaTrader 5
abierto en este mismo Windows:
  - precio del broker en/mejor que la entrada óptima -> orden a mercado
  - precio todavía no llega a la entrada            -> orden LIMIT en la entrada
SL y TP siempre van adjuntos a la orden.

Solo escucha en 127.0.0.1. Cuentas REAL bloqueadas salvo MT5_ALLOW_REAL=1.
"""
import json
import math
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

import MetaTrader5 as mt5

HOST = os.environ.get("MT5_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("MT5_BRIDGE_PORT", "8765"))
TOKEN = os.environ.get("MT5_BRIDGE_TOKEN", "")
ALLOW_REAL = os.environ.get("MT5_ALLOW_REAL") == "1"
TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH") or None
MAGIC = int(os.environ.get("MT5_MAGIC", "260901"))
MAX_BODY = 16 * 1024

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


def account_guard():
    ensure_connected()
    acc = mt5.account_info()
    if acc is None:
        raise BridgeError(503, f"MT5 sin cuenta conectada: {mt5.last_error()}")
    is_demo = acc.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO
    if not is_demo and not ALLOW_REAL:
        raise BridgeError(403, "Cuenta REAL bloqueada. Define MT5_ALLOW_REAL=1 si de verdad quieres operar en real.")
    term = mt5.terminal_info()
    if not term.trade_allowed:
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


def calc_volume(symbol, info, is_long, price, sl, equity, volume, risk_pct):
    if volume:
        raw = volume
    else:
        order_type = mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL
        loss_one_lot = mt5.order_calc_profit(order_type, symbol, 1.0, price, sl)
        if loss_one_lot is None or loss_one_lot >= 0:
            raise BridgeError(422, f"No se pudo calcular el riesgo por lote: {mt5.last_error()}")
        raw = (equity * risk_pct / 100.0) / abs(loss_one_lot)

    step = info.volume_step
    vol = round(math.floor(raw / step + 1e-9) * step, step_decimals(step))
    if vol < info.volume_min:
        raise BridgeError(
            422,
            f"Volumen calculado {raw:.4f} < lote mínimo {info.volume_min}. Sube el riesgo o usa 'volume' fijo.",
        )
    return min(vol, info.volume_max)


def filling_candidates(info):
    preferred = []
    if info.filling_mode & 1:
        preferred.append(mt5.ORDER_FILLING_FOK)
    if info.filling_mode & 2:
        preferred.append(mt5.ORDER_FILLING_IOC)
    preferred.append(mt5.ORDER_FILLING_RETURN)
    return preferred


def own_exposure(symbol):
    positions = [p for p in (mt5.positions_get(symbol=symbol) or ()) if p.magic == MAGIC]
    orders = [o for o in (mt5.orders_get(symbol=symbol) or ()) if o.magic == MAGIC]
    return len(positions), len(orders)


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


def place_order(payload):
    symbol = str(payload.get("symbol") or "").strip()
    side = str(payload.get("side") or "").upper()
    if not symbol:
        raise BridgeError(400, "Falta 'symbol'")
    if side not in ("LONG", "SHORT"):
        raise BridgeError(400, "'side' debe ser LONG o SHORT")
    # manual: sin chequeos de señal (coherencia, desvío, rango SL/TP, exposición); MT5 valida el resto.
    manual = bool(payload.get("manual"))
    order_mode = str(payload.get("order_mode") or ("market" if manual else "auto")).lower()
    if order_mode not in ORDER_MODES:
        raise BridgeError(400, f"'order_mode' debe ser {' | '.join(ORDER_MODES)}")
    if not manual and order_mode != "auto":
        raise BridgeError(400, "'order_mode' distinto de auto requiere 'manual'")
    if manual:
        return place_manual(payload, symbol, side, order_mode)
    entry = num(payload, "entry")
    sl = num(payload, "sl")
    tp = num(payload, "tp")
    volume = num(payload, "volume", required=False)
    risk_pct = num(payload, "risk_pct", required=False) or 0.5
    max_dev_pct = num(payload, "max_entry_deviation_pct", required=False) or 1.0
    deviation = int(num(payload, "deviation_points", required=False) or 20)
    expiry_minutes = int(payload.get("expiry_minutes") or 0)
    allow_multiple = bool(payload.get("allow_multiple"))
    dry_run = bool(payload.get("dry_run"))
    client_id = str(payload.get("client_id") or "")[:24]

    is_long = side == "LONG"
    if is_long and not (sl < entry < tp):
        raise BridgeError(422, "LONG requiere SL < entry < TP")
    if not is_long and not (tp < entry < sl):
        raise BridgeError(422, "SHORT requiere TP < entry < SL")

    acc, is_demo = account_guard()

    if not mt5.symbol_select(symbol, True):
        raise BridgeError(404, f"Símbolo '{symbol}' no existe en el broker (revisa MT5_SYMBOL_*).")
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        raise BridgeError(503, f"Sin cotización para {symbol}: {mt5.last_error()}")
    if info.trade_mode == mt5.SYMBOL_TRADE_MODE_DISABLED:
        raise BridgeError(409, f"{symbol} no permite operar ahora (mercado cerrado o deshabilitado).")

    market_price = tick.ask if is_long else tick.bid
    deviation_pct = abs(market_price - entry) / entry * 100
    if deviation_pct > max_dev_pct:
        raise BridgeError(
            422,
            f"Precio broker {market_price} está a {deviation_pct:.2f}% de la entrada {entry} "
            f"(máx {max_dev_pct}%). Feed de la señal y broker no coinciden.",
        )
    if is_long and not (sl < market_price < tp):
        raise BridgeError(409, f"Precio {market_price} ya fuera del rango SL/TP: señal invalidada o TP alcanzado.")
    if not is_long and not (tp < market_price < sl):
        raise BridgeError(409, f"Precio {market_price} ya fuera del rango SL/TP: señal invalidada o TP alcanzado.")

    if not allow_multiple:
        positions, orders = own_exposure(symbol)
        if positions or orders:
            raise BridgeError(
                409,
                f"Ya hay {positions} posición(es) y {orders} orden(es) de Flash Signals en {symbol}.",
            )

    digits = info.digits
    min_dist = info.trade_stops_level * info.point
    price_reached = market_price <= entry if is_long else market_price >= entry
    use_market = price_reached or abs(market_price - entry) <= min_dist
    price = market_price if use_market else entry

    if abs(price - sl) < min_dist or abs(tp - price) < min_dist:
        raise BridgeError(422, f"SL/TP demasiado cerca del precio (stops level {info.trade_stops_level} pts).")

    lots = calc_volume(symbol, info, is_long, price, sl, acc.equity, volume, risk_pct)
    comment = f"FS {client_id}".strip()[:31]

    request = {
        "symbol": symbol,
        "volume": lots,
        "price": round(price, digits),
        "sl": round(sl, digits),
        "tp": round(tp, digits),
        "magic": MAGIC,
        "comment": comment,
    }
    if use_market:
        request.update(
            action=mt5.TRADE_ACTION_DEAL,
            type=mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL,
            deviation=deviation,
            type_time=mt5.ORDER_TIME_GTC,
        )
        fillings = filling_candidates(info)
    else:
        request.update(
            action=mt5.TRADE_ACTION_PENDING,
            type=mt5.ORDER_TYPE_BUY_LIMIT if is_long else mt5.ORDER_TYPE_SELL_LIMIT,
            type_time=mt5.ORDER_TIME_GTC,
        )
        if expiry_minutes > 0 and info.expiration_mode & 4:
            request.update(type_time=mt5.ORDER_TIME_SPECIFIED, expiration=int(tick.time) + expiry_minutes * 60)
        fillings = [mt5.ORDER_FILLING_RETURN]

    summary = {
        "mode": "market" if use_market else "pending",
        "symbol": symbol,
        "side": side,
        "volume": lots,
        "price": request["price"],
        "sl": request["sl"],
        "tp": request["tp"],
        "marketPrice": market_price,
        "signalEntry": entry,
        "expiresAt": request.get("expiration"),
        "account": {"login": acc.login, "server": acc.server, "demo": is_demo},
    }
    return execute(request, fillings, summary, dry_run)


def execute(request, fillings, summary, dry_run):
    if dry_run:
        request["type_filling"] = fillings[0]
        check = mt5.order_check(request)
        return {
            "ok": check is not None and check.retcode in (0, mt5.TRADE_RETCODE_DONE),
            "dryRun": True,
            "check": None if check is None else {"retcode": check.retcode, "comment": check.comment},
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
    volume = num(payload, "volume", required=False)
    risk_pct = num(payload, "risk_pct", required=False) or 0.5
    deviation = int(num(payload, "deviation_points", required=False) or 20)
    expiry_minutes = int(payload.get("expiry_minutes") or 0)
    dry_run = bool(payload.get("dry_run"))
    client_id = str(payload.get("client_id") or "")[:24]
    is_long = side == "LONG"

    acc, is_demo = account_guard()

    if not mt5.symbol_select(symbol, True):
        raise BridgeError(404, f"Símbolo '{symbol}' no existe en el broker.")
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        raise BridgeError(503, f"Sin cotización para {symbol}: {mt5.last_error()}")

    market_price = tick.ask if is_long else tick.bid
    use_market = order_mode == "market" or (
        order_mode == "auto" and (entry is None or (market_price <= entry if is_long else market_price >= entry))
    )
    price = market_price if use_market else entry

    if volume is None and sl is None:
        raise BridgeError(422, "Sin SL no se puede calcular el riesgo: indica los lotes.")
    lots = calc_volume(symbol, info, is_long, price, sl, acc.equity, volume, risk_pct)
    digits = info.digits

    request = {
        "symbol": symbol,
        "volume": lots,
        "price": round(price, digits),
        "sl": round(sl, digits) if sl else 0.0,
        "tp": round(tp, digits) if tp else 0.0,
        "magic": MAGIC,
        "comment": f"FS manual {client_id}".strip()[:31],
        "type_time": mt5.ORDER_TIME_GTC,
    }
    if use_market:
        request.update(
            action=mt5.TRADE_ACTION_DEAL,
            type=mt5.ORDER_TYPE_BUY if is_long else mt5.ORDER_TYPE_SELL,
            deviation=deviation,
        )
        fillings = filling_candidates(info)
    else:
        stop = order_mode == "stop"
        if is_long:
            pending_type = mt5.ORDER_TYPE_BUY_STOP if stop else mt5.ORDER_TYPE_BUY_LIMIT
        else:
            pending_type = mt5.ORDER_TYPE_SELL_STOP if stop else mt5.ORDER_TYPE_SELL_LIMIT
        request.update(action=mt5.TRADE_ACTION_PENDING, type=pending_type)
        if expiry_minutes > 0 and info.expiration_mode & 4:
            request.update(type_time=mt5.ORDER_TIME_SPECIFIED, expiration=int(tick.time) + expiry_minutes * 60)
        fillings = [mt5.ORDER_FILLING_RETURN]

    summary = {
        "mode": "market" if use_market else ("stop" if stop else "pending"),
        "manual": True,
        "symbol": symbol,
        "side": side,
        "volume": lots,
        "price": request["price"],
        "sl": request["sl"] or None,
        "tp": request["tp"] or None,
        "marketPrice": market_price,
        "signalEntry": entry,
        "expiresAt": request.get("expiration"),
        "account": {"login": acc.login, "server": acc.server, "demo": is_demo},
    }
    return execute(request, fillings, summary, dry_run)


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

    def levels(price, sl, tp):
        return {"entry": price or None, "sl": sl or None, "tp": tp or None}

    pending = mt5.orders_get(ticket=ticket) or ()
    if pending:
        o = pending[0]
        return {"ok": True, "ticket": ticket, "state": "pending", "symbol": o.symbol,
                "volume": o.volume_current, **levels(o.price_open, o.sl, o.tp)}

    positions = mt5.positions_get(ticket=ticket) or ()
    if positions:
        p = positions[0]
        return {"ok": True, "ticket": ticket, "state": "open", "symbol": p.symbol, "volume": p.volume,
                "profit": round(p.profit + p.swap, 2), "currentPrice": p.price_current,
                **levels(p.price_open, p.sl, p.tp)}

    deals = list(mt5.history_deals_get(position=ticket) or ())
    if deals:
        entry = next((d for d in deals if d.entry == mt5.DEAL_ENTRY_IN), deals[0])
        exits = [d for d in deals if d.entry in (mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_OUT_BY)]
        hist = mt5.history_orders_get(ticket=ticket) or ()
        sl = hist[0].sl if hist else 0
        tp = hist[0].tp if hist else 0
        profit = round(sum(d.profit + d.swap + d.commission for d in deals), 2)
        if exits:
            last = exits[-1]
            return {"ok": True, "ticket": ticket, "state": "closed", "symbol": entry.symbol,
                    "volume": entry.volume, "profit": profit, "closePrice": last.price,
                    "closeReason": CLOSE_REASONS.get(last.reason, "manual"),
                    **levels(entry.price, sl, tp)}
        return {"ok": True, "ticket": ticket, "state": "open", "symbol": entry.symbol,
                "volume": entry.volume, "profit": profit, **levels(entry.price, sl, tp)}

    hist = mt5.history_orders_get(ticket=ticket) or ()
    if hist:
        o = hist[0]
        state = "expired" if o.state == mt5.ORDER_STATE_EXPIRED else "canceled"
        return {"ok": True, "ticket": ticket, "state": state, "symbol": o.symbol,
                "volume": o.volume_initial, **levels(o.price_open, o.sl, o.tp)}

    raise BridgeError(404, f"Ticket {ticket} no encontrado en MT5 (¿otra cuenta?).")


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
        if self.path == "/health":
            self._handle(health)
        else:
            self._send(404, {"ok": False, "error": "Ruta no encontrada"})

    def do_POST(self):
        if not self._authorized():
            return
        routes = {"/order": place_order, "/status": order_status}
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
    server = HTTPServer((HOST, PORT), Handler)
    print(f"[mt5-bridge] Escuchando en http://{HOST}:{PORT}  (magic={MAGIC}, allowReal={ALLOW_REAL})")
    try:
        server.serve_forever()
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
