/**
 * Parámetros de una operación enviada a MT5 (original y duplicada) para el modal «Parámetros»:
 * objetivo (TP) y SL actual en pips y en dinero, R:R, distancia desde el precio actual y flotante.
 * Puro: recibe la entrada de mt5-sent, la ficha del símbolo (tickSize/tickValue/bid/ask) y el pip.
 */

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const positive = (v) => (Number.isFinite(v) && v > 0 ? v : null);

/** Dinero por 1.0 de precio y 1 lote (tickValue / tickSize); null si el broker no lo informa. */
function moneyPerPriceUnit(details) {
  const tickSize = positive(Number(details?.tickSize));
  const tickValue = positive(Number(details?.tickValue));
  return tickSize && tickValue ? tickValue / tickSize : null;
}

/** Nivel → { price, pips, money } con signo: + si al tocarlo se gana, − si se pierde. */
function levelOutcome(level, entry, dir, { pipSize, perUnit, volume }) {
  if (!positive(level)) return null;
  const move = (level - entry) * dir;
  return {
    price: level,
    pips: round(move / pipSize, 1),
    money: perUnit && volume ? round(move * perUnit * volume) : null,
  };
}

/**
 * @param {object} leg entrada de mt5-sent (price, sl, tp, volume, side, state, profit…)
 * @param {{ pipSize: number, details: object|null, label: string }} ctx
 */
function legParams(leg, { pipSize, details, label }) {
  const dir = leg.side === 'SHORT' ? -1 : 1;
  const entry = positive(Number(leg.price));
  const volume = positive(Number(leg.volume));
  const perUnit = moneyPerPriceUnit(details);
  const opts = { pipSize, perUnit, volume };
  const sl = entry ? levelOutcome(Number(leg.sl), entry, dir, opts) : null;
  const tp = entry ? levelOutcome(Number(leg.tp), entry, dir, opts) : null;
  const exitSide = dir === 1 ? Number(details?.bid) : Number(details?.ask);
  const current = positive(exitSide);
  const live = leg.state === 'open' || leg.state === 'pending' || !leg.state;
  const floatingMove = entry && current && leg.state === 'open' ? (current - entry) * dir : null;
  const slDist = sl ? Math.abs(sl.pips) : null;
  const tpDist = tp ? Math.abs(tp.pips) : null;

  return {
    label,
    ticket: leg.order ?? null,
    side: leg.side ?? null,
    state: leg.state ?? null,
    volume,
    entry,
    sl,
    tp,
    /** SL más allá de la entrada a favor: si salta, se cobra (break-even o trailing). */
    slLocksProfit: !!sl && sl.pips >= 0,
    rr: slDist && tpDist && sl.pips < 0 ? round(tpDist / slDist, 2) : null,
    current: live ? current : null,
    toTpPips: live && current && tp ? round(((tp.price - current) * dir) / pipSize, 1) : null,
    toSlPips: live && current && sl ? round(((current - sl.price) * dir) / pipSize, 1) : null,
    /** 0 % = en la entrada, 100 % = en el TP, negativo = hacia el SL. */
    progressPct: floatingMove != null && tp ? round((floatingMove / Math.abs(tp.price - entry)) * 100, 0) : null,
    floatingPips: floatingMove == null ? null : round(floatingMove / pipSize, 1),
    floatingMoney: floatingMove != null && perUnit && volume ? round(floatingMove * perUnit * volume) : null,
    profit: Number.isFinite(leg.profit) ? leg.profit : null,
    closeReason: leg.closeReason ?? null,
    checkedAt: leg.checkedAt ?? null,
  };
}

const sumOrNull = (vals) => {
  const ok = vals.filter((v) => Number.isFinite(v));
  return ok.length ? round(ok.reduce((a, b) => a + b, 0)) : null;
};

/**
 * @param {object} sent entrada de mt5-sent (con duplicate opcional)
 * @param {{ pipSize: number, details: object|null, symbol: string, market: string }} ctx
 */
function positionParams(sent, { pipSize, details, symbol, market }) {
  const legs = [legParams(sent, { pipSize, details, label: 'Original' })];
  if (sent.duplicate?.order) legs.push(legParams(sent.duplicate, { pipSize, details, label: 'Duplicada' }));
  return {
    market,
    symbol,
    pipSize,
    currency: details?.currency || 'USD',
    bid: positive(Number(details?.bid)),
    ask: positive(Number(details?.ask)),
    moneyAvailable: moneyPerPriceUnit(details) != null,
    legs,
    total: {
      tpMoney: sumOrNull(legs.map((l) => l.tp?.money)),
      slMoney: sumOrNull(legs.map((l) => l.sl?.money)),
      floatingMoney: sumOrNull(legs.map((l) => l.floatingMoney)),
      profit: sumOrNull(legs.map((l) => l.profit)),
    },
  };
}

module.exports = { positionParams, legParams, moneyPerPriceUnit };
