/**
 * Estilos de operación del Run operation (Scalping / Day trading): cada perfil MT5 define, por estilo,
 * el margen extra del SL (pips), el TP por R:R y el riesgo % con el que se recalcula el lote.
 */
const TRADE_STYLES = ['scalping', 'daytrading'];
const STYLE_LABELS = { scalping: 'Scalping', daytrading: 'Day trading' };
const STYLE_FIELDS = ['extraSlPips', 'extraTpPips', 'riskPct', 'tpRr'];

const STYLE_RANGES = {
  extraSlPips: { min: 0, max: 10000 },
  extraTpPips: { min: 0, max: 10000 },
  riskPct: { min: 0, max: 5, minExclusive: true },
  tpRr: { min: 0, max: 10, minExclusive: true },
};

/**
 * Valores por defecto derivados del perfil, para que activar los estilos no cambie el riesgo de golpe:
 * Scalping = mitad del SL extra del perfil y TP 1:1; Day trading = SL/TP extra del perfil y TP 1:2.
 * Ambos con el riesgo % del perfil.
 */
function defaultStyles(profile = {}) {
  const extraSl = Number(profile.extraSlPips) || 0;
  const extraTp = Number(profile.extraTpPips) || 0;
  const riskPct = Number(profile.riskPct) > 0 ? Number(profile.riskPct) : 0.5;
  return {
    scalping: { extraSlPips: Math.round(extraSl / 2), extraTpPips: 0, riskPct, tpRr: 1 },
    daytrading: { extraSlPips: extraSl, extraTpPips: extraTp, riskPct, tpRr: 2 },
  };
}

/** Estilos guardados (parciales) completados con los derivados del perfil. */
function completeStyles(saved, profile) {
  const base = defaultStyles(profile);
  const out = {};
  for (const id of TRADE_STYLES) out[id] = { ...base[id], ...saved?.[id] };
  return out;
}

function mergeStyles(base = {}, patch = {}) {
  const out = { ...base };
  for (const id of TRADE_STYLES) {
    if (patch[id]) out[id] = { ...base[id], ...patch[id] };
  }
  return out;
}

function styleNumber(errors, label, raw, { min, max, minExclusive = false }) {
  const n = Number(raw);
  const tooLow = minExclusive ? n <= min : n < min;
  if (raw === '' || raw == null || !Number.isFinite(n) || tooLow || n > max) {
    errors.push(`${label}: debe ser ${minExclusive ? '>' : '≥'} ${min} y ≤ ${max}`);
    return undefined;
  }
  return n;
}

/** tpRr vacío / null / 0 = sin R:R (TP de la señal + TP extra del estilo). */
function validateTpRr(errors, label, raw) {
  if (raw === null || raw === '' || Number(raw) === 0) return null;
  return styleNumber(errors, label, raw, STYLE_RANGES.tpRr);
}

function validateStyle(errors, id, raw) {
  if (!raw || typeof raw !== 'object') {
    errors.push(`styles.${id}: objeto { extraSlPips, extraTpPips, riskPct, tpRr }`);
    return undefined;
  }
  const out = {};
  for (const field of STYLE_FIELDS) {
    if (raw[field] === undefined) continue;
    const label = `styles.${id}.${field}`;
    const v = field === 'tpRr' ? validateTpRr(errors, label, raw[field]) : styleNumber(errors, label, raw[field], STYLE_RANGES[field]);
    if (v !== undefined) out[field] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validador del campo `styles` de mt5-settings: (errors, raw) → { scalping?, daytrading? } | undefined. */
function validateStyles(errors, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`styles: objeto { ${TRADE_STYLES.join(', ')} }`);
    return undefined;
  }
  const out = {};
  for (const id of TRADE_STYLES) {
    if (raw[id] === undefined) continue;
    const v = validateStyle(errors, id, raw[id]);
    if (v !== undefined) out[id] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** `style` del body de /api/mt5/push → { style: id|null } | { error }. */
function parseStyle(raw) {
  if (raw == null || raw === '') return { style: null };
  if (typeof raw === 'string' && TRADE_STYLES.includes(raw)) return { style: raw };
  return { error: `style debe ser ${TRADE_STYLES.join(' | ')}` };
}

/** Estilo efectivo del perfil (guardado o derivado) con su id y etiqueta. */
function resolveStyle(settings, id) {
  if (!TRADE_STYLES.includes(id)) return null;
  const style = completeStyles(settings?.styles, settings)[id];
  return { id, label: STYLE_LABELS[id], ...style };
}

const roundPrice = (n) => Math.round(n * 1e6) / 1e6;

/**
 * SL/TP de un estilo:
 *   SL = SL señal ∓ extraSlPips × pip (se aleja de la entrada)
 *   TP = entrada ± tpRr × |entrada − SL|        si tpRr > 0
 *   TP = TP señal ± extraTpPips × pip           si tpRr vacío (fallback)
 */
function styleStops(market, side, { entry, sl, tp }, style, settings = {}) {
  const pip = Number(settings.pipSize?.[market]) || 0;
  const dir = side === 'LONG' ? 1 : -1;
  const slFinal = sl - dir * (Number(style.extraSlPips) || 0) * pip;
  const rr = Number(style.tpRr) || 0;
  const tpFinal = rr > 0 ? entry + dir * rr * Math.abs(entry - slFinal) : tp + dir * (Number(style.extraTpPips) || 0) * pip;
  return { sl: roundPrice(slFinal), tp: roundPrice(tpFinal) };
}

/** «Scalping · riesgo 1 % · SL +15 pips · TP R:R 1:1» (o «TP señal +30 pips» sin R:R; «lotes fijos» si aplica). */
function styleSummary(style, { fixedVolume = null } = {}) {
  const risk = fixedVolume ? `lotes fijos ${fixedVolume}` : `riesgo ${style.riskPct} %`;
  const tp = Number(style.tpRr) > 0 ? `TP R:R 1:${style.tpRr}` : `TP señal +${style.extraTpPips || 0} pips`;
  return `${style.label} · ${risk} · SL +${style.extraSlPips || 0} pips · ${tp}`;
}

module.exports = {
  TRADE_STYLES,
  STYLE_LABELS,
  completeStyles,
  defaultStyles,
  mergeStyles,
  parseStyle,
  resolveStyle,
  styleStops,
  styleSummary,
  validateStyles,
};
