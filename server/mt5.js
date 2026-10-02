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
 * anyVerdict: el trader decide ejecutar un plan aunque el veredicto no sea ENTRAR (Run operation del historial).
 * @returns {{ order?: object, skip?: string }}
 */
function buildOrderFromSummary(market, summary, settings = mt5Settings.get(), { anyVerdict = false } = {}) {
  if (!summary) return { skip: 'Sin resumen de señal' };
  if (!anyVerdict && !/entrar/i.test(String(summary.verdict || ''))) {
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

  return { order: { symbol, side, entry, ...padStops(market, side, sl, tp, settings) } };
}

const roundPrice = (n) => Math.round(n * 1e6) / 1e6;

/** Aleja SL y TP de la entrada extraSlPips / extraTpPips × pipSize del mercado. */
function padStops(market, side, sl, tp, settings = {}) {
  const pip = Number(settings.pipSize?.[market]) || 0;
  const slPad = (Number(settings.extraSlPips) || 0) * pip;
  const tpPad = (Number(settings.extraTpPips) || 0) * pip;
  const dir = side === 'LONG' ? 1 : -1;
  return { sl: roundPrice(sl - dir * slPad), tp: roundPrice(tp + dir * tpPad) };
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

/**
 * Duplicar: segunda operación con el mismo lote y Entrada/SL/TP actuales de la original
 * (LIMIT si sigue pendiente, a mercado si ya está abierta). Va como orden manual: sin chequeos de señal.
 * @param {object} sent entrada de mt5-sent de la original
 * @param {object} status estado real de la original (puente /status)
 * @returns {{ order?: object, error?: string }}
 */
function buildDuplicateOrder(sent = {}, status = {}) {
  if (status.state !== 'pending' && status.state !== 'open') {
    return { error: `La operación original está ${STATE_LABELS[status.state] || status.state || 'desconocida'}: no se puede duplicar` };
  }
  const side = String(sent.side || '').toUpperCase();
  if (side !== 'LONG' && side !== 'SHORT') return { error: 'La operación original no tiene lado LONG/SHORT' };
  const volume = positiveNumber(status.volume) ?? positiveNumber(sent.volume);
  if (!volume) return { error: 'La operación original no tiene lote' };
  const order = { symbol: status.symbol || sent.symbol, side, volume, manual: true };
  const sl = positiveNumber(status.sl) ?? positiveNumber(sent.sl);
  const tp = positiveNumber(status.tp) ?? positiveNumber(sent.tp);
  if (sl) order.sl = sl;
  if (tp) order.tp = tp;
  if (status.state === 'pending') {
    const entry = positiveNumber(status.entry) ?? positiveNumber(sent.price);
    if (!entry) return { error: 'La orden pendiente original no tiene precio de entrada' };
    Object.assign(order, { order_mode: 'limit', entry });
  } else {
    order.order_mode = 'market';
  }
  return { order };
}

/**
 * Resultado conjunto de la original y su duplicado: solo cuando ambas terminaron.
 * PnL = suma; no tomada si ninguna se ejecutó.
 */
function combineAnnotations(main, dup) {
  if (!main || !dup) return null;
  if (main.resultado === 'no_tomada' && dup.resultado === 'no_tomada') return { resultado: 'no_tomada' };
  const pnl = Math.round(((main.pnlUsd ?? 0) + (dup.pnlUsd ?? 0)) * 100) / 100;
  return { resultado: pnl >= 0 ? 'ganada' : 'perdida', pnlUsd: pnl };
}

const STATE_LABELS = {
  pending: 'pendiente (LIMIT)',
  open: 'abierta',
  closed: 'cerrada',
  canceled: 'cancelada',
  expired: 'expirada',
};

/**
 * Recalcular: compara el envío registrado con el estado real de MT5.
 * @param {object} sent entrada de mt5-sent (price/sl/tp enviados)
 * @param {object} status respuesta del puente /status
 * @returns {{ levels: object, annotation: object|null, changes: string[], sentPatch: object, message: string }}
 */
function reconcileOrder(sent = {}, status = {}) {
  const changes = [];
  const fields = [
    ['entry', 'price', 'Entrada'],
    ['sl', 'sl', 'SL'],
    ['tp', 'tp', 'TP'],
  ];
  for (const [key, sentKey, label] of fields) {
    const now = positiveNumber(status[key]);
    const before = positiveNumber(sent[sentKey]);
    if (now != null && now !== before) changes.push(`${label} ${before ?? '—'} → ${now}`);
  }
  if (status.volume != null && sent.volume != null && Number(status.volume) !== Number(sent.volume)) {
    changes.push(`Lotes ${sent.volume} → ${status.volume}`);
  }

  let annotation = null;
  if (status.state === 'closed' && Number.isFinite(Number(status.profit))) {
    const profit = Number(status.profit);
    annotation = { resultado: profit >= 0 ? 'ganada' : 'perdida', pnlUsd: profit };
  } else if (status.state === 'canceled' || status.state === 'expired') {
    annotation = { resultado: 'no_tomada' };
  }

  const sentPatch = {
    original: sent.original ?? { price: sent.price ?? null, sl: sent.sl ?? null, tp: sent.tp ?? null, volume: sent.volume ?? null },
    lastChanges: changes,
    state: status.state ?? null,
    price: positiveNumber(status.entry) ?? sent.price ?? null,
    sl: positiveNumber(status.sl) ?? sent.sl ?? null,
    tp: positiveNumber(status.tp) ?? sent.tp ?? null,
    volume: status.volume ?? sent.volume ?? null,
    profit: Number.isFinite(Number(status.profit)) ? Number(status.profit) : null,
    closeReason: status.closeReason ?? null,
    checkedAt: new Date().toISOString(),
  };

  const parts = [`Orden ${STATE_LABELS[status.state] || status.state || 'desconocida'}`];
  parts.push(changes.length ? `reajustada: ${changes.join(' · ')}` : 'sin cambios en Entrada/SL/TP');
  if (annotation?.pnlUsd != null) parts.push(`PnL ${annotation.pnlUsd} USD (${annotation.resultado})`);
  else if (annotation) parts.push('marcada como no tomada');

  return {
    levels: { entry: status.entry, sl: status.sl, tp: status.tp },
    annotation,
    changes,
    sentPatch,
    message: parts.join(' · '),
  };
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

/** Estado real en MT5 de un ticket enviado: pending | open | closed | canceled | expired. */
function orderStatus(ticket, settings) {
  return callBridge('POST', '/status', { ticket }, settings);
}

/** Deals compra/venta de un símbolo en [from, to] (epoch UTC en segundos), horas ya en UTC. */
function historyDeals({ symbol, from, to }, settings) {
  return callBridge('POST', '/deals', { symbol, from, to }, settings);
}

/**
 * Variables de entorno para los scripts de Cursor Trading: velas del broker (puente /rates)
 * con los símbolos del perfil activo, para que análisis y chart usen la escala de precio de MT5.
 */
function brokerFeedEnv(settings = mt5Settings.get()) {
  const env = { FS_MT5_BRIDGE_URL: settings.bridgeUrl || '' };
  if (settings.bridgeToken) env.FS_MT5_BRIDGE_TOKEN = settings.bridgeToken;
  for (const [market, key] of [['us30', 'US30'], ['xauusd', 'XAUUSD'], ['btc', 'BTC']]) {
    const symbol = symbolFor(market, settings);
    if (symbol) env[`FS_MT5_SYMBOL_${key}`] = symbol;
  }
  return env;
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
  brokerFeedEnv,
  buildDuplicateOrder,
  buildManualOrder,
  combineAnnotations,
  buildOrderFromSummary,
  bridgeHealth,
  historyDeals,
  orderStatus,
  padStops,
  pushOrder,
  reconcileOrder,
  symbolFor,
};
