/**
 * $/PnL real desde MT5 para una fila del historial (Auto captura).
 * Agrupa los deals del puente por posición y busca la operación cerrada de la señal:
 *  1. la etiquetada por la app (comentario «FS h<id>» u orden registrada en mt5-sent);
 *  2. si no hay, misma dirección, abierta entre la hora de la señal y +24 h, entrada a ≤ maxDeviationPct
 *     del plan, eligiendo la de entrada más cercana (empate → ambigua).
 * PnL = Σ (profit + commission + swap + fee) de todos los deals de la posición (resultado neto).
 * Nunca inventa un número: sin conexión, sin coincidencia o con varias plausibles devuelve un aviso.
 */
const ENTRY_SLACK_MS = 2 * 60_000;
const ENTRY_WINDOW_MS = 24 * 3600_000;
const MAX_QUERY_MS = 60 * 24 * 3600_000;
/** Dos entradas a menos de esta fracción del precio planificado son igual de plausibles. */
const AMBIGUOUS_TOL = 0.0001;
const VOLUME_EPS = 1e-6;
const MONEY_FIELDS = ['profit', 'commission', 'swap', 'fee'];
const RESULTADO_LABEL = { ganada: 'Ganada', perdida: 'Perdida' };
const OWN_TAG_RE = /^FS h(\d+)\b/;

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const hhmm = (ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

/** Dirección, entrada y hora de la señal desde la fila (getById). */
function resolvePnlInput(row) {
  if (!row) return { ok: false, error: 'Entrada no encontrada', code: 'not_found' };
  const entry = row.plannedEntry;
  const sl = row.plannedSl;
  const tp = row.plannedTp;
  if (![entry, sl, tp].every((v) => Number.isFinite(v) && v > 0)) {
    return { ok: false, error: 'Sin niveles SL/Entrada/TP para buscar la operación en MT5', code: 'no_levels' };
  }
  let side = null;
  if (sl < entry && entry < tp) side = 'BUY';
  else if (tp < entry && entry < sl) side = 'SELL';
  if (!side) return { ok: false, error: 'Plan incoherente: no se puede deducir BUY/SELL', code: 'no_side' };
  const signalMs = Date.parse(row.finishedAt || row.createdAt || '');
  if (!Number.isFinite(signalMs)) return { ok: false, error: 'La señal no tiene hora registrada', code: 'no_time' };
  return { ok: true, input: { market: row.market, side, entry, signalMs } };
}

function newPosition(deal, login) {
  const pos = { position: deal.position, login, symbol: deal.symbol, side: null, entryPrice: null, entryTime: null };
  Object.assign(pos, { closeTime: null, volumeIn: 0, volumeOut: 0, exitNotional: 0, comment: '', deals: [] });
  for (const k of MONEY_FIELDS) pos[k] = 0;
  return pos;
}

function addDeal(pos, d) {
  pos.deals.push(d.ticket);
  for (const k of MONEY_FIELDS) pos[k] += num(d[k]);
  const timeMs = num(d.time) * 1000;
  if (d.entry === 'in') {
    pos.volumeIn += num(d.volume);
    if (pos.entryTime == null || timeMs < pos.entryTime) {
      Object.assign(pos, { side: d.type, entryPrice: num(d.price), entryTime: timeMs, comment: String(d.comment || '') });
    }
  } else if (d.entry === 'out') {
    pos.volumeOut += num(d.volume);
    pos.exitNotional += num(d.price) * num(d.volume);
    pos.closeTime = Math.max(pos.closeTime ?? 0, timeMs);
  }
}

const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString());

/**
 * Deals del puente → posiciones con importes sumados, salida = media ponderada por volumen de los cierres
 * y hora de cierre = último deal de salida.
 * @param {Array<object>} deals { ticket, position, symbol, type BUY|SELL, entry in|out, volume, price, profit, commission, swap, fee, time (s UTC), comment }
 * @param {Record<string, { sl?: number|null }>} [levels] SL/TP de apertura por posición (puente)
 */
function groupPositions(deals = [], login = null, levels = {}) {
  const byId = new Map();
  for (const d of deals) {
    if (!d?.position) continue;
    if (!byId.has(d.position)) byId.set(d.position, newPosition(d, login));
    addDeal(byId.get(d.position), d);
  }
  return [...byId.values()]
    .filter((p) => p.side)
    .map((p) => {
      for (const k of MONEY_FIELDS) p[k] = round2(p[k]);
      const net = round2(MONEY_FIELDS.reduce((s, k) => s + p[k], 0));
      const exitPrice = p.volumeOut > 0 ? Math.round((p.exitNotional / p.volumeOut) * 1e6) / 1e6 : null;
      const sl = Number(levels?.[String(p.position)]?.sl);
      return {
        ...p,
        net,
        exitPrice,
        sl: sl > 0 ? sl : null,
        closed: p.volumeOut > 0 && p.volumeOut >= p.volumeIn - VOLUME_EPS,
      };
    });
}

function ownTag(pos) {
  const m = OWN_TAG_RE.exec(pos.comment || '');
  return m ? Number(m[1]) : null;
}

const fail = (code, warning) => ({ ok: false, code, warning });
const ticketList = (list) => list.map((p) => `#${p.position}`).join(', ');

/** Elige una posición cerrada entre las candidatas (ordenadas por cercanía) o explica por qué no. */
function pickClosed(candidates, { label, signalMs, tol }) {
  const closed = candidates.filter((p) => p.closed);
  if (!closed.length) {
    const open = candidates.find((p) => !p.closed);
    if (open) return fail('open', `MT5: la operación #${open.position} de ${label} sigue abierta`);
    return fail('no_match', `MT5: no se encontró una operación cerrada de ${label} desde ${hhmm(signalMs)}`);
  }
  if (closed.length > 1 && closed[1].distance - closed[0].distance <= tol) {
    const tied = closed.filter((p) => p.distance - closed[0].distance <= tol);
    return fail('ambiguous', `Varias operaciones coinciden (${ticketList(tied)}); ingresa el PnL a mano`);
  }
  return { ok: true, position: closed[0] };
}

/**
 * @param {{ positions: object[], input: object, symbol: string, historyId: number, sentOrders?: number[], maxDeviationPct?: number }} args
 * @returns {{ ok: true, position: object } | { ok: false, code: string, warning: string }}
 */
function matchPosition({ positions, input, symbol, historyId, sentOrders = [], maxDeviationPct = 1 }) {
  const label = `${symbol} ${input.side}`;
  const withDistance = (p) => ({ ...p, distance: Math.abs(p.entryPrice - input.entry) });
  const byDistance = (a, b) => a.distance - b.distance;
  const ctx = { label, signalMs: input.signalMs, tol: input.entry * AMBIGUOUS_TOL };

  const own = positions.filter((p) => ownTag(p) === historyId || sentOrders.includes(p.position));
  if (own.length) return pickClosed(own.map(withDistance).sort(byDistance), { ...ctx, tol: Infinity });

  const maxDistance = (input.entry * maxDeviationPct) / 100;
  const candidates = positions
    .filter((p) => ownTag(p) == null && p.side === input.side)
    .filter((p) => p.entryTime >= input.signalMs - ENTRY_SLACK_MS && p.entryTime <= input.signalMs + ENTRY_WINDOW_MS)
    .map(withDistance)
    .filter((p) => p.distance <= maxDistance)
    .sort(byDistance);
  return pickClosed(candidates, ctx);
}

/** Valor a guardar + aviso si el signo contradice el Resultado (que nunca se cambia). */
function buildPnl(position, resultado) {
  const value = position.net;
  const chosen = RESULTADO_LABEL[resultado] ? resultado : null;
  const mismatch = (chosen === 'ganada' && value < 0) || (chosen === 'perdida' && value > 0);
  return {
    value,
    source: 'mt5',
    ticket: position.position,
    deals: position.deals,
    login: position.login,
    breakdown: Object.fromEntries(MONEY_FIELDS.map((k) => [k, position[k]])),
    execution: {
      entry: position.entryPrice,
      exit: position.exitPrice,
      sl: position.sl ?? null,
      openedAt: isoOrNull(position.entryTime),
      closedAt: isoOrNull(position.closeTime),
    },
    mismatch,
    warning: mismatch
      ? `MT5 da ${value.toFixed(2)} USD (#${position.position}) pero marcaste ${RESULTADO_LABEL[chosen]}. Revisa el resultado.`
      : null,
  };
}

/** fill: guardar · same: ya coincide · confirm: hay un PnL manual distinto (pedir confirmación). */
function decideApply(current, value, overwrite = false) {
  if (current == null || current === 0) return 'fill';
  if (Math.abs(current - value) < 0.005) return 'same';
  return overwrite ? 'fill' : 'confirm';
}

function offlineWarning(errors) {
  if (errors.every((e) => (e.status ?? 503) === 503)) return 'MT5 no conectado';
  return `MT5: ${errors[0].message}`;
}

/**
 * Busca el PnL de la fila en los puentes MT5 configurados (activo primero; duplicados de cuenta se fusionan).
 * @param {{ row: object, resultado?: string|null, profiles: Array<{ id: string, settings: object, sentOrder?: number|null }>,
 *   fetchDeals: (query: object, settings: object) => Promise<object>, nowMs?: number }} args
 */
async function lookupMt5Pnl({ row, resultado, profiles, fetchDeals, nowMs = Date.now() }) {
  const resolved = resolvePnlInput(row);
  if (!resolved.ok) return fail(resolved.code, resolved.error);
  const { input } = resolved;
  const fromMs = input.signalMs - ENTRY_SLACK_MS;
  const query = { from: Math.floor(fromMs / 1000), to: Math.ceil(Math.min(nowMs, fromMs + MAX_QUERY_MS) / 1000) };

  const usable = profiles.filter((p) => p.settings?.symbols?.[input.market]);
  if (!usable.length) return fail('market', `Mercado ${input.market} sin símbolo MT5`);
  const results = await Promise.all(
    usable.map((p) =>
      fetchDeals({ ...query, symbol: p.settings.symbols[input.market] }, p.settings)
        .then((data) => ({ profile: p, data }))
        .catch((error) => ({ profile: p, error }))
    )
  );
  const ok = results.filter((r) => !r.error);
  if (!ok.length) return fail('mt5_offline', offlineWarning(results.map((r) => r.error)));

  const seen = new Set();
  const positions = [];
  for (const { data } of ok) {
    const login = data.account?.login ?? null;
    for (const p of groupPositions(data.deals, login, data.positions)) {
      const key = `${login}:${p.position}`;
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push(p);
    }
  }
  const main = ok[0].profile;
  const match = matchPosition({
    positions,
    input,
    symbol: main.settings.symbols[input.market],
    historyId: Number(row.id),
    sentOrders: profiles.map((p) => Number(p.sentOrder)).filter((n) => Number.isInteger(n) && n > 0),
    maxDeviationPct: Number(main.settings.maxDeviationPct) || 1,
  });
  if (!match.ok) return match;
  return { ok: true, pnl: buildPnl(match.position, resultado ?? row.resultado) };
}

module.exports = {
  resolvePnlInput,
  groupPositions,
  matchPosition,
  buildPnl,
  decideApply,
  lookupMt5Pnl,
};
