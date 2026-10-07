/**
 * Volatilidad: niveles por puntos de VIX, ajuste de SL/TP y calculadora de volatilidad.
 * Lógica pura (sin red ni disco): la fuente del VIX está en vix-source.js y las rutas en volatility-routes.js.
 */

const LEVELS = ['baja', 'normal', 'alta', 'extrema'];
const LEVEL_LABELS = { baja: 'Baja', normal: 'Normal', alta: 'Alta', extrema: 'Extrema' };

/** Valores por defecto: umbrales superiores (puntos VIX) y multiplicador de SL/TP por nivel. */
const VIX_DEFAULTS = {
  vixLowMax: 15,
  vixNormalMax: 20,
  vixHighMax: 30,
  vixMultLow: 0.8,
  vixMultNormal: 1,
  vixMultHigh: 1.3,
  vixMultExtreme: 1.6,
};

const MULT_KEYS = { baja: 'vixMultLow', normal: 'vixMultNormal', alta: 'vixMultHigh', extrema: 'vixMultExtreme' };

/** «¿Qué tan movido está el mercado?» → nivel de volatilidad equivalente. */
const MOODS = ['tranquilo', 'normal', 'movido', 'muy_movido'];
const MOOD_LEVEL = { tranquilo: 'baja', normal: 'normal', movido: 'alta', muy_movido: 'extrema' };

/** SL base = 2 × ATR(14) de M5 (dos «latidos» típicos del mercado); TP = SL × 2 (relación 1:2). */
const SL_ATR_MULT = 2;
const REWARD_RATIO = 2;
const ATR_PERIOD = 14;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function thresholds(settings = {}) {
  return {
    low: num(settings.vixLowMax, VIX_DEFAULTS.vixLowMax),
    normal: num(settings.vixNormalMax, VIX_DEFAULTS.vixNormalMax),
    high: num(settings.vixHighMax, VIX_DEFAULTS.vixHighMax),
  };
}

/** Baja < low · Normal [low, normal) · Alta [normal, high] · Extrema > high. null si los puntos no son válidos. */
function classifyVix(points, settings = {}) {
  const p = Number(points);
  if (points == null || points === '' || !Number.isFinite(p) || p <= 0) return null;
  const t = thresholds(settings);
  if (p < t.low) return 'baja';
  if (p < t.normal) return 'normal';
  if (p <= t.high) return 'alta';
  return 'extrema';
}

/** Multiplicador de SL/TP del nivel (1 si el nivel o el ajuste no son válidos). */
function levelMultiplier(level, settings = {}) {
  const key = MULT_KEYS[level];
  if (!key) return 1;
  const m = num(settings[key], VIX_DEFAULTS[key]);
  return m > 0 ? m : 1;
}

/** Los umbrales deben ser crecientes: baja < normal < alta. → mensaje de error o null. */
function thresholdsError(settings) {
  const t = thresholds(settings);
  if (t.low < t.normal && t.normal < t.high) return null;
  return 'Umbrales VIX: deben cumplir baja < normal < alta (vixLowMax < vixNormalMax < vixHighMax)';
}

const roundPrice = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Multiplica las distancias entrada→SL y entrada→TP de la señal. Con multiplicador > 0 el orden
 * SL < entry < TP (LONG) / TP < entry < SL (SHORT) se conserva siempre.
 */
function applyVolatilityToStops({ entry, side, sl, tp, multiplier }) {
  const m = Number(multiplier);
  if (!Number.isFinite(m) || m <= 0 || m === 1) return { sl, tp };
  const dir = side === 'LONG' ? 1 : -1;
  return {
    sl: roundPrice(entry - dir * Math.abs(entry - sl) * m),
    tp: roundPrice(entry + dir * Math.abs(tp - entry) * m),
  };
}

function fmt(n, decimals = 1) {
  const text = Number(n).toFixed(decimals);
  return (text.includes('.') ? text.replace(/\.?0+$/, '') : text).replace('.', ',');
}

/**
 * Resultado de ajustar por VIX al construir una orden.
 * @param {object} settings perfil MT5
 * @param {{ points?: number, source?: string, asOf?: string, error?: string }|null} reading lectura del VIX
 * @returns {null | { applied: boolean, multiplier: number, level: string|null, points: number|null, source: string|null, asOf: string|null, note: string }}
 *   null si el ajuste está desactivado (no hay nada que mostrar ni que pedir).
 */
function resolveVolatilityAdjustment(settings = {}, reading = null) {
  if (!settings.volatilityAdjustEnabled) return null;
  const level = classifyVix(reading?.points, settings);
  if (!level) {
    const why = reading?.error ? `: ${reading.error}` : '';
    return {
      applied: false,
      multiplier: 1,
      level: null,
      points: null,
      source: null,
      asOf: null,
      note: `No se pudo leer el VIX${why}. SL/TP sin ajuste (×1)`,
    };
  }
  const multiplier = levelMultiplier(level, settings);
  const points = Number(reading.points);
  const change = multiplier === 1 ? 'sin cambio' : multiplier > 1 ? 'se ensanchan' : 'se estrechan';
  return {
    applied: multiplier !== 1,
    multiplier,
    level,
    points,
    source: reading.source ?? null,
    asOf: reading.asOf ?? null,
    note: `VIX ${fmt(points, 2)} (${LEVEL_LABELS[level].toLowerCase()}) · SL/TP ×${fmt(multiplier, 2)} (${change})`,
  };
}

/**
 * ATR (Wilder) con velas cerradas: la última vela del puente sigue formándose y se descarta.
 * @param {{ high: number, low: number, close: number }[]} candles de más antigua a más reciente
 * @returns {number|null} null si no hay velas suficientes (period + 2)
 */
function atrFromCandles(candles, period = ATR_PERIOD) {
  const closed = (candles || []).slice(0, -1);
  if (closed.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < closed.length; i++) {
    const { high, low } = closed[i];
    const prevClose = closed[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function badInput(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/**
 * Calculadora de volatilidad (sin matemáticas para el usuario):
 *  1. Distancia del SL = 2 × movimiento típico de 5 min (ATR14 M5) × multiplicador del nivel de volatilidad.
 *  2. TP = el doble de lejos que el SL (relación 1:2).
 *  3. Dinero que se pierde por lote = distancia del SL ÷ tamaño del tick × valor del tick.
 *  4. Lotes = (saldo × riesgo %) ÷ pérdida por lote, redondeado hacia abajo al paso del broker
 *     (si sale menos que el mínimo se usa el mínimo y se avisa del riesgo real).
 *  5. Margen extra sugerido = 1 × movimiento típico × multiplicador (SL) y el doble para el TP.
 * @param {object} input
 * @param {number} input.atr movimiento típico de una vela de 5 min, en precio
 * @param {number} input.multiplier multiplicador de SL/TP del nivel elegido
 * @param {number} input.riskPct % del saldo que se acepta perder
 * @param {number} input.balance saldo de la cuenta
 * @param {number} input.pipSize precio de 1 pip del mercado
 * @param {{ tickSize: number, tickValue: number, volumeMin: number, volumeMax: number, volumeStep: number, digits?: number }} input.symbol
 */
function calculatePlan({ atr, multiplier, riskPct, balance, pipSize, symbol }) {
  const mult = num(multiplier, NaN);
  if (!(atr > 0)) throw badInput('Sin movimiento de mercado (ATR) para calcular');
  if (!(mult > 0)) throw badInput('multiplier debe ser > 0');
  if (!(riskPct > 0) || riskPct > 100) throw badInput('riskPct debe ser > 0 y ≤ 100');
  if (!(balance > 0)) throw badInput('Indica el saldo de la cuenta');
  if (!(pipSize > 0)) throw badInput('pipSize debe ser > 0');
  const { tickSize, tickValue, volumeMin, volumeMax, volumeStep } = symbol || {};
  if (!(tickSize > 0) || !(tickValue > 0)) throw badInput('El broker no informa el valor del tick del símbolo');
  if (!(volumeMin > 0) || !(volumeStep > 0)) throw badInput('El broker no informa los lotes del símbolo');

  const digits = Number.isInteger(symbol.digits) ? symbol.digits : 5;
  const round = (n, d = digits) => Math.round(n * 10 ** d) / 10 ** d;
  const pips = (distance) => Math.round((distance / pipSize) * 10) / 10;

  const slDistance = round(atr * SL_ATR_MULT * mult);
  const tpDistance = round(slDistance * REWARD_RATIO);
  const moneyPerPriceUnit = tickValue / tickSize;
  const lossPerLot = slDistance * moneyPerPriceUnit;
  const targetRisk = (balance * riskPct) / 100;

  const stepDecimals = (String(volumeStep).split('.')[1] || '').length;
  let lots = Math.floor(targetRisk / lossPerLot / volumeStep + 1e-9) * volumeStep;
  lots = Math.round(lots * 10 ** stepDecimals) / 10 ** stepDecimals;
  let lotNote = null;
  if (lots < volumeMin) {
    lots = volumeMin;
    lotNote = `Con tu riesgo saldría menos que el lote mínimo del broker (${volumeMin}): se usa el mínimo y arriesgas más de lo elegido.`;
  } else if (volumeMax > 0 && lots > volumeMax) {
    lots = volumeMax;
    lotNote = `Se limita al lote máximo del broker (${volumeMax}).`;
  }

  const riskAmount = lots * lossPerLot;
  const rewardAmount = lots * tpDistance * moneyPerPriceUnit;
  const extraSl = round(atr * mult);
  return {
    slDistance,
    tpDistance,
    slPips: pips(slDistance),
    tpPips: pips(tpDistance),
    lots,
    lotNote,
    riskAmount: Math.round(riskAmount * 100) / 100,
    rewardAmount: Math.round(rewardAmount * 100) / 100,
    realRiskPct: Math.round((riskAmount / balance) * 10000) / 100,
    rewardRatio: REWARD_RATIO,
    extraSlPips: Math.round(extraSl / pipSize),
    extraTpPips: Math.round((extraSl * REWARD_RATIO) / pipSize),
  };
}

module.exports = {
  ATR_PERIOD,
  LEVELS,
  LEVEL_LABELS,
  MOODS,
  MOOD_LEVEL,
  MULT_KEYS,
  REWARD_RATIO,
  SL_ATR_MULT,
  VIX_DEFAULTS,
  applyVolatilityToStops,
  atrFromCandles,
  calculatePlan,
  classifyVix,
  levelMultiplier,
  resolveVolatilityAdjustment,
  thresholdsError,
};
