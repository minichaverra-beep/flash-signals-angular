/**
 * Si el riesgo del plan está en zona alta, el SL se mueve al soporte (compra)
 * o a la resistencia (venta) que la señal ya trae, si ese nivel queda más allá del stop.
 */
const HIGH_RISK_FILL = 66;
/** Pips reales más allá del soporte o la resistencia. Oro: 20 × 0,10 = 2 de precio. */
const SLIPPAGE_PIPS = 20;

function realPipSize(market) {
  const key = String(market || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (key.startsWith('XAU') || key === 'GOLD') return 0.1;
  return 1;
}

function firstNumber(raw) {
  const match = /(-?\d+(?:[.,]\d+)?)/.exec(String(raw ?? ''));
  if (!match) return null;
  const n = Number(match[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parseRewardMultiple(rr) {
  if (!rr) return null;
  const t = String(rr).trim().toLowerCase().replace(',', '.');
  const parts = t.split(/[:/]|(?<=\d)\s*a\s*(?=\d)/);
  if (parts.length >= 2) {
    const a = firstNumber(parts[0]);
    const b = firstNumber(parts[1]);
    if (a != null && b != null && a !== 0) return b >= a ? b / a : a / b;
  }
  const n = firstNumber(t);
  return n != null && n > 0 ? n : null;
}

function heatFromRewardMultiple(mult) {
  if (mult >= 2.2) return Math.round(33 - Math.min(1, Math.max(0, (mult - 2.2) / 0.5)) * 25);
  if (mult >= 1.4) return Math.round(33 + ((2.2 - mult) / 0.8) * 33);
  return Math.round(66 + Math.min(1, Math.max(0, (1.4 - mult) / 0.6)) * 34);
}

function heatFromPricePct(pct) {
  if (pct < 0.35) return Math.round(8 + (Math.max(0, pct) / 0.35) * 25);
  if (pct < 0.9) return Math.round(33 + ((pct - 0.35) / 0.55) * 33);
  return Math.round(66 + Math.min(1, (pct - 0.9) / 0.9) * 34);
}

/** Misma barra que el póster. Null si no hay R:R ni distancia contra el precio. */
function riskFill(plan, price) {
  const points = firstNumber(plan?.risk);
  const entry = firstNumber(plan?.entry) ?? firstNumber(price);
  const reward = parseRewardMultiple(plan?.rr);
  if (reward == null && (points == null || entry == null || entry === 0)) {
    const sl = firstNumber(plan?.sl);
    if (entry == null || sl == null || entry === 0) return null;
    return heatFromPricePct(Math.abs(((entry - sl) / entry) * 100));
  }
  if (reward != null) return heatFromRewardMultiple(reward);
  return heatFromPricePct(Math.abs((points / entry) * 100));
}

function structureLevels(engine) {
  const support = [];
  const resistance = [];
  const detail = String(engine?.crt?.h1_detail || '');
  const range = /rango\s+h1\s+([0-9]+(?:[.,][0-9]+)?)\s*[-–]\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(detail);
  if (range) {
    const a = firstNumber(range[1]);
    const b = firstNumber(range[2]);
    if (a != null && b != null && a !== b) {
      support.push(Math.min(a, b));
      resistance.push(Math.max(a, b));
    }
  }
  const scan = engine?.ict?.scan;
  const level = firstNumber(scan?.zone_level);
  const kind = String(scan?.zone_type || '').toLowerCase();
  if (level != null && kind.includes('soport')) support.push(level);
  else if (level != null && kind.includes('resist')) resistance.push(level);
  return { support, resistance };
}

/**
 * Soporte o resistencia más cercana más allá del stop, y 20 pips reales más lejos
 * para cubrir el slippage. Null si el riesgo no es alto o no hay nivel.
 */
function expandSlIfHighRisk({ market, entry, sl, plan, price, engine }) {
  const fill = riskFill(plan, price);
  if (fill == null || fill < HIGH_RISK_FILL) return null;
  const entryN = Number(entry);
  const slN = Number(sl);
  if (!Number.isFinite(entryN) || !Number.isFinite(slN) || entryN === slN || entryN <= 0 || slN <= 0) return null;
  const buy = slN < entryN;
  const levels = structureLevels(engine);
  const beyond = (buy ? levels.support : levels.resistance).filter((level) => (buy ? level < slN : level > slN));
  if (!beyond.length) return null;
  const level = buy ? Math.max(...beyond) : Math.min(...beyond);
  const pad = SLIPPAGE_PIPS * realPipSize(market);
  const widened = buy ? level - pad : level + pad;
  if (!(widened > 0) || (buy ? widened >= slN : widened <= slN)) return null;
  return Math.round(widened * 1e6) / 1e6;
}

module.exports = { HIGH_RISK_FILL, riskFill, expandSlIfHighRisk };
