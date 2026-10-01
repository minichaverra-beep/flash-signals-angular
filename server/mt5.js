/**
 * Envío de planes de señal (Entry/SL/TP) al puente MT5 local (mt5-bridge/bridge.py).
 * El puente decide mercado vs LIMIT según el precio del broker frente a la entrada óptima.
 * Parámetros (símbolos, riesgo, puente…) desde mt5-settings (pantalla Configuración).
 */
const mt5Settings = require('./mt5-settings');

const TIMEOUT_MS = 15000;

function symbolFor(market, settings = mt5Settings.get()) {
  return settings.symbols?.[market] || null;
}

function tradeDefaults(settings) {
  return {
    risk_pct: settings.riskPct,
    volume: settings.volume,
    max_entry_deviation_pct: settings.maxDeviationPct,
    expiry_minutes: settings.expiryMinutes,
    deviation_points: settings.deviationPoints,
    allow_multiple: settings.allowMultiple,
  };
}

function positiveNumber(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Convierte el summary de un reporte en una orden MT5.
 * El lado se deduce de la geometría SL/TP (no del texto), así un plan incoherente se descarta.
 * @returns {{ order?: object, skip?: string }}
 */
function buildOrderFromSummary(market, summary, settings = mt5Settings.get()) {
  if (!summary) return { skip: 'Sin resumen de señal' };
  if (!/entrar/i.test(String(summary.verdict || ''))) {
    return { skip: `Veredicto "${summary.verdict || 'n/d'}": no se envía orden` };
  }
  const symbol = symbolFor(market, settings);
  if (!symbol) return { skip: `Mercado ${market} sin símbolo MT5` };

  const plan = summary.planDetails || {};
  const entry = positiveNumber(plan.entry);
  const sl = positiveNumber(plan.sl);
  const tp = positiveNumber(plan.tp);
  if (!entry || !sl || !tp) return { skip: 'Plan sin Entry/SL/TP numéricos' };

  let side = null;
  if (sl < entry && entry < tp) side = 'LONG';
  else if (tp < entry && entry < sl) side = 'SHORT';
  if (!side) return { skip: `Plan incoherente: entry=${entry} sl=${sl} tp=${tp}` };

  return { order: { symbol, side, entry, sl, tp } };
}

const MANUAL_ORDER_MODES = ['market', 'limit', 'stop', 'auto'];
const SYMBOL_RE = /^[A-Za-z0-9._#+-]{1,32}$/;

/**
 * Orden manual (botón "Operación manual"): sin veredicto ni chequeos de señal.
 * Símbolo del mercado (perfil) o uno libre; SL/TP opcionales; entry obligatoria en limit/stop.
 * @returns {{ order?: object, error?: string }}
 */
function buildManualOrder(body = {}, settings = mt5Settings.get()) {
  const symbol = body.symbol ? String(body.symbol).trim() : symbolFor(body.market, settings);
  if (!symbol) return { error: 'Indica market (btc | us30 | xauusd) o symbol' };
  if (!SYMBOL_RE.test(symbol)) return { error: 'symbol inválido' };

  const side = String(body.side || '').toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') return { error: 'side debe ser LONG o SHORT' };

  const orderMode = String(body.orderMode || 'market').toLowerCase();
  if (!MANUAL_ORDER_MODES.includes(orderMode)) {
    return { error: `orderMode debe ser ${MANUAL_ORDER_MODES.join(' | ')}` };
  }

  const order = { symbol, side, manual: true, order_mode: orderMode };
  for (const key of ['entry', 'sl', 'tp', 'volume']) {
    if (body[key] == null || body[key] === '') continue;
    const n = positiveNumber(body[key]);
    if (!n) return { error: `${key} debe ser un número > 0` };
    order[key] = n;
  }
  if ((orderMode === 'limit' || orderMode === 'stop') && !order.entry) {
    return { error: `orderMode ${orderMode} requiere entry` };
  }
  if (!order.volume && !order.sl && !settings.volume) {
    return { error: 'Sin SL no se puede calcular el riesgo: indica volume' };
  }
  return { order };
}

async function callBridge(method, path, body, settings = mt5Settings.get()) {
  const { bridgeUrl, bridgeToken } = settings;
  const headers = { 'Content-Type': 'application/json' };
  if (bridgeToken) headers['X-Bridge-Token'] = bridgeToken;
  let res;
  try {
    res = await fetch(`${bridgeUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const error = new Error(`Puente MT5 no disponible en ${bridgeUrl} (${err.message})`);
    error.status = 503;
    throw error;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const error = new Error(data.error || `Puente MT5 respondió ${res.status}`);
    error.status = res.status >= 400 ? res.status : 502;
    error.details = data;
    throw error;
  }
  return data;
}

/** @param {object} [settings] perfil a probar (por defecto el activo). */
function bridgeHealth(settings) {
  return callBridge('GET', '/health', undefined, settings);
}

/** @param {object} order salida de buildOrderFromSummary; overrides: volume, risk_pct, dry_run… */
function pushOrder(order, { clientId, ...overrides } = {}, settings = mt5Settings.get()) {
  return callBridge(
    'POST',
    '/order',
    {
      ...tradeDefaults(settings),
      ...order,
      ...overrides,
      client_id: clientId ? String(clientId) : undefined,
    },
    settings
  );
}

module.exports = {
  buildManualOrder,
  buildOrderFromSummary,
  bridgeHealth,
  pushOrder,
  symbolFor,
};
