"""
Sustituto de la librería MetaTrader5 sobre MetaApi (REST), para correr bridge.py sin Windows.

bridge.py lo importa como `mt5` con MT5_BACKEND=metaapi. Implementa solo lo que usa el puente,
con las mismas firmas, constantes y objetos (atributos) que MetaTrader5. Todas las horas van en
epoch UTC, por eso fija MT5_SERVER_UTC_OFFSET_SEC=0 (el puente no corrige hora de servidor).

Configuración (variables de entorno):
  METAAPI_TOKEN       token de la API (app.metaapi.cloud > API access)
  METAAPI_ACCOUNT_ID  id de la cuenta MT5 añadida en MetaApi
  METAAPI_REGION      región de la cuenta (por defecto new-york)
Solo usa la biblioteca estándar: no añade dependencias en Android.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from types import SimpleNamespace as NS

os.environ.setdefault("MT5_SERVER_UTC_OFFSET_SEC", "0")

TOKEN = os.environ.get("METAAPI_TOKEN", "")
ACCOUNT_ID = os.environ.get("METAAPI_ACCOUNT_ID", "")
REGION = os.environ.get("METAAPI_REGION", "new-york")
TIMEOUT_SEC = float(os.environ.get("METAAPI_TIMEOUT_SEC", "60"))
_ACCOUNT_PATH = f"/users/current/accounts/{urllib.parse.quote(ACCOUNT_ID)}"
CLIENT_URL = f"https://mt-client-api-v1.{REGION}.agiliumtrade.ai{_ACCOUNT_PATH}"
MARKET_URL = f"https://mt-market-data-client-api-v1.{REGION}.agiliumtrade.ai{_ACCOUNT_PATH}"
MAX_CANDLES_PER_CALL = 1000
PAGE_SIZE = 1000

# --- Constantes con los mismos valores que MetaTrader5 ---
ACCOUNT_TRADE_MODE_DEMO, ACCOUNT_TRADE_MODE_CONTEST, ACCOUNT_TRADE_MODE_REAL = 0, 1, 2
ORDER_TYPE_BUY, ORDER_TYPE_SELL = 0, 1
ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_LIMIT, ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP = 2, 3, 4, 5
ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = 0, 1, 2
ORDER_TIME_GTC, ORDER_TIME_DAY, ORDER_TIME_SPECIFIED = 0, 1, 2
ORDER_STATE_STARTED, ORDER_STATE_PLACED, ORDER_STATE_CANCELED, ORDER_STATE_PARTIAL = 0, 1, 2, 3
ORDER_STATE_FILLED, ORDER_STATE_REJECTED, ORDER_STATE_EXPIRED = 4, 5, 6
TRADE_ACTION_DEAL, TRADE_ACTION_PENDING = 1, 5
TRADE_RETCODE_PLACED, TRADE_RETCODE_DONE, TRADE_RETCODE_DONE_PARTIAL = 10008, 10009, 10010
TRADE_RETCODE_INVALID_FILL = 10030
DEAL_TYPE_BUY, DEAL_TYPE_SELL = 0, 1
DEAL_ENTRY_IN, DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT, DEAL_ENTRY_OUT_BY = 0, 1, 2, 3
DEAL_REASON_CLIENT, DEAL_REASON_SL, DEAL_REASON_TP, DEAL_REASON_SO = 0, 4, 5, 6
SYMBOL_TRADE_MODE_DISABLED, SYMBOL_TRADE_MODE_FULL = 0, 4
# copy_rates_* recibe directamente el timeframe de MetaApi
TIMEFRAME_M1, TIMEFRAME_M5, TIMEFRAME_M15, TIMEFRAME_H1, TIMEFRAME_H4 = "1m", "5m", "15m", "1h", "4h"

_ORDER_TYPE_NAMES = {
    ORDER_TYPE_BUY: "ORDER_TYPE_BUY", ORDER_TYPE_SELL: "ORDER_TYPE_SELL",
    ORDER_TYPE_BUY_LIMIT: "ORDER_TYPE_BUY_LIMIT", ORDER_TYPE_SELL_LIMIT: "ORDER_TYPE_SELL_LIMIT",
    ORDER_TYPE_BUY_STOP: "ORDER_TYPE_BUY_STOP", ORDER_TYPE_SELL_STOP: "ORDER_TYPE_SELL_STOP",
}
_FILLING_NAMES = {ORDER_FILLING_FOK: "ORDER_FILLING_FOK", ORDER_FILLING_IOC: "ORDER_FILLING_IOC",
                  ORDER_FILLING_RETURN: "ORDER_FILLING_RETURN"}
_ORDER_STATES = {"ORDER_STATE_STARTED": ORDER_STATE_STARTED, "ORDER_STATE_PLACED": ORDER_STATE_PLACED,
                 "ORDER_STATE_CANCELED": ORDER_STATE_CANCELED, "ORDER_STATE_PARTIAL": ORDER_STATE_PARTIAL,
                 "ORDER_STATE_FILLED": ORDER_STATE_FILLED, "ORDER_STATE_REJECTED": ORDER_STATE_REJECTED,
                 "ORDER_STATE_EXPIRED": ORDER_STATE_EXPIRED}
_DEAL_TYPES = {"DEAL_TYPE_BUY": DEAL_TYPE_BUY, "DEAL_TYPE_SELL": DEAL_TYPE_SELL}
_DEAL_ENTRIES = {"DEAL_ENTRY_IN": DEAL_ENTRY_IN, "DEAL_ENTRY_OUT": DEAL_ENTRY_OUT,
                 "DEAL_ENTRY_INOUT": DEAL_ENTRY_INOUT, "DEAL_ENTRY_OUT_BY": DEAL_ENTRY_OUT_BY}
_DEAL_REASONS = {"DEAL_REASON_CLIENT": DEAL_REASON_CLIENT, "DEAL_REASON_SL": DEAL_REASON_SL,
                 "DEAL_REASON_TP": DEAL_REASON_TP, "DEAL_REASON_SO": DEAL_REASON_SO}
_ACCOUNT_MODES = {"ACCOUNT_TRADE_MODE_DEMO": ACCOUNT_TRADE_MODE_DEMO,
                  "ACCOUNT_TRADE_MODE_CONTEST": ACCOUNT_TRADE_MODE_CONTEST}
_SYMBOL_TRADE_MODES = {"SYMBOL_TRADE_MODE_DISABLED": 0, "SYMBOL_TRADE_MODE_LONGONLY": 1,
                       "SYMBOL_TRADE_MODE_SHORTONLY": 2, "SYMBOL_TRADE_MODE_CLOSEONLY": 3,
                       "SYMBOL_TRADE_MODE_FULL": SYMBOL_TRADE_MODE_FULL}
# Máscaras de bits de symbol_info().filling_mode / expiration_mode en MT5
_FILLING_BITS = {"SYMBOL_FILLING_FOK": 1, "SYMBOL_FILLING_IOC": 2}
_EXPIRATION_BITS = {"SYMBOL_EXPIRATION_GTC": 1, "SYMBOL_EXPIRATION_DAY": 2,
                    "SYMBOL_EXPIRATION_SPECIFIED": 4, "SYMBOL_EXPIRATION_SPECIFIED_DAY": 8}

_FAIL = object()
_last_error = (1, "Success")
_cache = {}


def last_error():
    return _last_error


def _set_error(code, message):
    global _last_error
    _last_error = (code, message)


def _request(method, url, body=None, missing_ok=False):
    """JSON de MetaApi; None si 404 y missing_ok; _FAIL (y last_error) ante cualquier otro fallo."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"auth-token": TOKEN, "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:  # NOSONAR: URL fija de MetaApi (https)
            raw = res.read()
        return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        if missing_ok and err.code == 404:
            return None
        detail = err.read().decode("utf-8", "replace")[:300]
        _set_error(-err.code, f"MetaApi respondió {err.code}: {detail}")
    except (urllib.error.URLError, TimeoutError, ValueError) as err:
        _set_error(-1, f"MetaApi sin respuesta: {err}")
    return _FAIL


def _get(path, missing_ok=False, base=CLIENT_URL):
    return _request("GET", f"{base}{path}", missing_ok=missing_ok)


def _cached(key, ttl, fn):
    hit = _cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < ttl:
        return hit[1]
    value = fn()
    if value is not _FAIL and value is not None:
        _cache[key] = (now, value)
    return value


def _ts(iso):
    return int(datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp())


def _iso(epoch):
    return datetime.fromtimestamp(int(epoch), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _quote(symbol):
    return urllib.parse.quote(str(symbol), safe="")


# --- Conexión y cuenta ---

def initialize(*_args, **_kwargs):
    if not TOKEN or not ACCOUNT_ID:
        _set_error(-2, "Faltan METAAPI_TOKEN y/o METAAPI_ACCOUNT_ID")
        return False
    return _account_raw() is not None


def shutdown():
    _cache.clear()


def _account_raw():
    if not TOKEN or not ACCOUNT_ID:
        _set_error(-2, "Faltan METAAPI_TOKEN y/o METAAPI_ACCOUNT_ID")
        return None
    raw = _cached("account", 2.0, lambda: _get("/account-information"))
    return None if raw is _FAIL else raw


def account_info():
    a = _account_raw()
    if a is None:
        return None
    return NS(
        login=a.get("login"), server=a.get("server", ""), currency=a.get("currency", "USD"),
        trade_mode=_ACCOUNT_MODES.get(a.get("type"), ACCOUNT_TRADE_MODE_REAL),
        balance=float(a.get("balance") or 0.0), equity=float(a.get("equity") or 0.0),
        margin_free=float(a.get("freeMargin") or 0.0), trade_expert=True,
    )


def terminal_info():
    a = _account_raw()
    if a is None:
        return None
    return NS(connected=True, trade_allowed=bool(a.get("tradeAllowed", True)), tradeapi_disabled=False, path="")


# --- Símbolos y precios ---

def _spec(symbol):
    raw = _cached(f"spec:{symbol}", 600.0, lambda: _get(f"/symbols/{_quote(symbol)}/specification", missing_ok=True))
    return None if raw is _FAIL else raw


def _price(symbol):
    raw = _cached(f"price:{symbol}", 1.0,
                  lambda: _get(f"/symbols/{_quote(symbol)}/current-price?keepSubscription=true", missing_ok=True))
    return None if raw is _FAIL else raw


def symbol_select(symbol, _enable=True):
    return _spec(symbol) is not None


def symbol_info(symbol):
    s = _spec(symbol)
    p = _price(symbol)
    if s is None or p is None:
        return None
    filling = sum(_FILLING_BITS.get(m, 0) for m in s.get("fillingModes") or ())
    expiration = sum(_EXPIRATION_BITS.get(m, 0) for m in s.get("allowedExpirationModes") or ())
    return NS(
        name=s.get("symbol", symbol), description=s.get("description", ""), path=s.get("path", ""), visible=True,
        digits=int(s.get("digits") or 0), point=float(s.get("point") or s.get("tickSize") or 0.0),
        volume_min=float(s["minVolume"]), volume_max=float(s["maxVolume"]), volume_step=float(s["volumeStep"]),
        trade_stops_level=int(s.get("stopsLevel") or 0), filling_mode=filling, expiration_mode=expiration,
        trade_mode=_SYMBOL_TRADE_MODES.get(s.get("tradeMode"), SYMBOL_TRADE_MODE_FULL),
        trade_tick_size=float(s.get("tickSize") or 0.0), trade_contract_size=float(s.get("contractSize") or 0.0),
        trade_tick_value=float(p.get("profitTickValue") or 0.0),
        trade_tick_value_loss=float(p.get("lossTickValue") or 0.0),
    )


def symbol_info_tick(symbol):
    p = _price(symbol)
    if p is None:
        return None
    return NS(bid=float(p["bid"]), ask=float(p["ask"]), time=_ts(p["time"]))


def symbols_get():
    names = _cached("symbols", 600.0, lambda: _get("/symbols"))
    if names is _FAIL or names is None:
        return None
    return [NS(name=n, description="", path="", visible=False) for n in names]


def order_calc_profit(order_type, symbol, volume, price_open, price_close):
    """Como MT5: ticks de diferencia × valor del tick (de pérdida si va en contra) × lotes."""
    s = _spec(symbol)
    p = _price(symbol)
    tick_size = float((s or {}).get("tickSize") or 0.0)
    if p is None or not tick_size:
        _set_error(-3, f"Sin especificación o precio de {symbol}")
        return None
    direction = 1 if order_type in (ORDER_TYPE_BUY, ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_BUY_STOP) else -1
    diff = (price_close - price_open) * direction
    tick_value = float((p.get("profitTickValue") if diff > 0 else p.get("lossTickValue")) or 0.0)
    return diff / tick_size * tick_value * volume


def order_calc_margin(order_type, symbol, volume, price):
    body = {"symbol": symbol, "type": _ORDER_TYPE_NAMES.get(order_type, "ORDER_TYPE_BUY"),
            "volume": volume, "openPrice": price}
    raw = _request("POST", f"{CLIENT_URL}/calculate-margin", body)
    return None if raw is _FAIL or not raw else raw.get("margin")


# --- Órdenes, posiciones e historial ---

def _order(o):
    return NS(
        ticket=int(o["id"]), symbol=o.get("symbol", ""), magic=int(o.get("magic") or 0),
        time_setup=_ts(o["time"]), price_open=float(o.get("openPrice") or 0.0),
        sl=float(o.get("stopLoss") or 0.0), tp=float(o.get("takeProfit") or 0.0),
        volume_initial=float(o.get("volume") or 0.0), volume_current=float(o.get("currentVolume") or 0.0),
        state=_ORDER_STATES.get(o.get("state"), ORDER_STATE_CANCELED),
    )


def _matching(items, ticket):
    return tuple(i for i in items if ticket is None or i.ticket == int(ticket))


def orders_get(ticket=None):
    raw = _get("/orders")
    return None if raw is _FAIL else _matching([_order(o) for o in raw or ()], ticket)


def positions_get(ticket=None):
    raw = _get("/positions")
    if raw is _FAIL:
        return None
    positions = [
        NS(ticket=int(p["id"]), symbol=p.get("symbol", ""), volume=float(p.get("volume") or 0.0),
           profit=float(p.get("profit") or 0.0), swap=float(p.get("swap") or 0.0),
           price_open=float(p.get("openPrice") or 0.0), price_current=float(p.get("currentPrice") or 0.0),
           sl=float(p.get("stopLoss") or 0.0), tp=float(p.get("takeProfit") or 0.0))
        for p in raw or ()
    ]
    return _matching(positions, ticket)


def _deal(d):
    return NS(
        ticket=int(d["id"]), position_id=int(d.get("positionId") or 0), symbol=d.get("symbol", ""),
        type=_DEAL_TYPES.get(d.get("type"), -1), entry=_DEAL_ENTRIES.get(d.get("entryType"), -1),
        volume=float(d.get("volume") or 0.0), price=float(d.get("price") or 0.0),
        profit=float(d.get("profit") or 0.0), commission=float(d.get("commission") or 0.0),
        swap=float(d.get("swap") or 0.0), fee=0.0, time=_ts(d["time"]), magic=int(d.get("magic") or 0),
        comment=d.get("comment", ""), reason=_DEAL_REASONS.get(d.get("reason"), -1),
    )


def _paged(path):
    rows, offset = [], 0
    while True:
        page = _get(f"{path}?offset={offset}&limit={PAGE_SIZE}")
        if page is _FAIL:
            return _FAIL
        rows.extend(page or ())
        if len(page or ()) < PAGE_SIZE:
            return rows
        offset += PAGE_SIZE


def history_deals_get(date_from=None, date_to=None, position=None):
    if position is not None:
        raw = _get(f"/history-deals/position/{int(position)}")
    else:
        raw = _paged(f"/history-deals/time/{_iso(date_from)}/{_iso(date_to)}")
    return None if raw is _FAIL else tuple(_deal(d) for d in raw or ())


def history_orders_get(ticket=None, position=None):
    path = f"/history-orders/ticket/{int(ticket)}" if ticket is not None else f"/history-orders/position/{int(position)}"
    raw = _get(path)
    return None if raw is _FAIL else tuple(_order(o) for o in raw or ())


# --- Envío de órdenes ---

def order_check(request):
    """MetaApi no tiene comprobación previa: valida lo básico y deja la decisión final al envío."""
    info = symbol_info(request.get("symbol"))
    if info is None:
        return None
    volume = float(request.get("volume") or 0.0)
    if not info.volume_min <= volume <= info.volume_max:
        return NS(retcode=10014, comment=f"Volumen {volume} fuera de [{info.volume_min}, {info.volume_max}]")
    return NS(retcode=0, comment="Sin comprobación previa en MetaApi: el broker valida al enviar")


def _trade_body(request):
    body = {
        "actionType": _ORDER_TYPE_NAMES[request["type"]],
        "symbol": request["symbol"],
        "volume": request["volume"],
        "magic": request.get("magic"),
        # comment + clientId ≤ 26 caracteres en MetaApi
        "comment": str(request.get("comment") or "")[:26],
        "fillingModes": [_FILLING_NAMES.get(request.get("type_filling"), "ORDER_FILLING_RETURN")],
    }
    if request.get("sl"):
        body["stopLoss"] = request["sl"]
    if request.get("tp"):
        body["takeProfit"] = request["tp"]
    if request.get("action") == TRADE_ACTION_PENDING:
        body["openPrice"] = request["price"]
        if request.get("type_time") == ORDER_TIME_SPECIFIED and request.get("expiration"):
            body["expiration"] = {"type": "ORDER_TIME_SPECIFIED", "time": _iso(request["expiration"])}
    else:
        body["slippage"] = request.get("deviation", 0)
    return body


def order_send(request):
    raw = _request("POST", f"{CLIENT_URL}/trade", _trade_body(request))
    if raw is _FAIL or not raw:
        return None
    _cache.pop("account", None)
    ticket = raw.get("orderId") or raw.get("positionId") or 0
    return NS(retcode=int(raw.get("numericCode") or 0), comment=raw.get("message") or raw.get("stringCode", ""),
              order=int(ticket), deal=0, price=0.0)


# --- Velas ---

def _candles(symbol, timeframe, count, start_time=None):
    rows, cursor = {}, start_time
    while len(rows) < count:
        limit = min(MAX_CANDLES_PER_CALL, count - len(rows))
        query = f"limit={limit}" + (f"&startTime={_iso(cursor)}" if cursor is not None else "")
        page = _get(f"/historical-market-data/symbols/{_quote(symbol)}/timeframes/{timeframe}/candles?{query}",
                    base=MARKET_URL)
        if page is _FAIL:
            return None
        if not page:
            break
        for c in page:
            t = _ts(c["time"])
            rows[t] = {"time": t, "open": c["open"], "high": c["high"], "low": c["low"], "close": c["close"],
                       "tick_volume": int(c.get("tickVolume") or 0)}
        oldest = min(_ts(c["time"]) for c in page)
        if len(page) < limit or (cursor is not None and oldest >= cursor):
            break
        cursor = oldest - 1
    return [rows[t] for t in sorted(rows)][-count:]


def copy_rates_from_pos(symbol, timeframe, _start_pos, count):
    return _candles(symbol, timeframe, count)


def copy_rates_from(symbol, timeframe, date_from, count):
    return _candles(symbol, timeframe, count, start_time=date_from)
