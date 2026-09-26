/**
 * Recalcula Probabilidad de éxito (scoreCombined) con la lógica v2:
 *  - penalización ubicación (Break LONG en PREMIUM / SHORT en DISCOUNT)
 *  - blend 62/38 con Acuerdo entre capas (confluencePct)
 *
 * El score histórico guardado = fusión pre-acuerdo (sin estos pasos).
 * Idempotente: guarda scoreCombinedBeforeRecalc + scoreRecalcVersion.
 */

const RECALC_VERSION = 'v2-acuerdo-ubicacion';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrae dirección / setup / PD / confluencia desde summary (+ preview MD opcional).
 * @param {Record<string, any>|null} summary
 * @param {string|null} preview
 * @param {Record<string, boolean>|null} flags
 */
function extractRecalcContext(summary, preview, flags) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const md = typeof preview === 'string' ? preview : '';

  let direction = null;
  const bias = String(s.bias || '').toLowerCase();
  if (flags?.bullish || /bullish|alcista|long/i.test(bias)) direction = 'LONG';
  if (flags?.bearish || /bearish|bajista|short/i.test(bias)) direction = 'SHORT';
  const verdict = String(s.verdict || '');
  if (!direction) {
    if (/LONG/i.test(verdict)) direction = 'LONG';
    else if (/SHORT/i.test(verdict)) direction = 'SHORT';
  }
  if (!direction && md) {
    if (/dirección\s*\*\*LONG\*\*|ENTRAR LONG|ESPERAR LONG/i.test(md)) direction = 'LONG';
    else if (/dirección\s*\*\*SHORT\*\*|ENTRAR SHORT|ESPERAR SHORT/i.test(md))
      direction = 'SHORT';
  }

  let setupMode = 'auto';
  const setup = String(s.setup || '');
  if (/break/i.test(setup)) setupMode = 'break';
  else if (/reverse|revers/i.test(setup)) setupMode = 'reverse';
  if (md) {
    if (/Modo setup[^\n]*BREAK|modo \*\*BREAK/i.test(md)) setupMode = 'break';
    else if (/Modo setup[^\n]*REVERSE|modo \*\*REVERSE/i.test(md))
      setupMode = 'reverse';
  }

  let premiumDiscount = null;
  if (md) {
    const pdM = md.match(
      /Posici[oó]n precio:\s*\*\*(PREMIUM|DISCOUNT|EQUILIBRIO[^*]*)\*\*/i
    );
    if (pdM) {
      const raw = pdM[1].toUpperCase();
      if (raw.startsWith('PREMIUM')) premiumDiscount = 'PREMIUM';
      else if (raw.startsWith('DISCOUNT')) premiumDiscount = 'DISCOUNT';
    }
    if (!premiumDiscount) {
      const pd2 = md.match(/Premium\/Discount\s*\*\*(PREMIUM|DISCOUNT)/i);
      if (pd2) premiumDiscount = pd2[1].toUpperCase();
    }
  }
  // Dirección tags in summary sometimes say Premium
  if (!premiumDiscount && Array.isArray(s.tags)) {
    const names = s.tags.map((t) => String(t.name || t).toLowerCase());
    if (names.some((n) => n.includes('premium'))) premiumDiscount = 'PREMIUM';
    if (names.some((n) => n.includes('descuento') || n.includes('discount')))
      premiumDiscount = 'DISCOUNT';
  }

  let confluencePct = parseNum(s.confluencePct);
  let confluenceLabel = s.confluenceLabel || null;
  if (confluencePct == null && md) {
    const confM =
      md.match(
        /Confluencia\s+\*?\*?([A-ZÁÉÍÓÚ]+)\*?\*?\s*[-–—]?\s*(\d+(?:[.,]\d+)?)\s*%/i
      ) || md.match(/Confluencia\s+\*?\*?(\d+(?:[.,]\d+)?)\s*%/i);
    if (confM) {
      if (confM[2]) {
        confluenceLabel = confM[1];
        confluencePct = parseNum(confM[2]);
      } else if (/^\d/.test(confM[1])) {
        confluencePct = parseNum(confM[1]);
      }
    }
  }
  if (!confluenceLabel && confluencePct != null) {
    if (confluencePct >= 75) confluenceLabel = 'ALTA';
    else if (confluencePct >= 50) confluenceLabel = 'MEDIA';
    else if (confluencePct >= 25) confluenceLabel = 'BAJA';
    else confluenceLabel = 'NULA';
  }

  const rulesPct = parseNum(s.rulesPct);

  return {
    direction,
    setupMode,
    premiumDiscount,
    confluencePct,
    confluenceLabel,
    rulesPct,
  };
}

function locationMultiplier(direction, premiumDiscount, setupMode) {
  const mode = (setupMode || 'auto').toLowerCase();
  if (direction === 'LONG' && premiumDiscount === 'PREMIUM') {
    return mode === 'break' ? 0.72 : 0.88;
  }
  if (direction === 'SHORT' && premiumDiscount === 'DISCOUNT') {
    return mode === 'break' ? 0.72 : 0.88;
  }
  return 1.0;
}

/**
 * @param {number} preAcuerdo fusion score before location+blend (histórico)
 * @param {ReturnType<typeof extractRecalcContext>} ctx
 */
function computeNewProbabilidad(preAcuerdo, ctx) {
  let combined = Number(preAcuerdo);
  if (!Number.isFinite(combined)) return null;

  const locMult = locationMultiplier(
    ctx.direction,
    ctx.premiumDiscount,
    ctx.setupMode
  );
  const afterLoc = combined * locMult;

  let blended = afterLoc;
  let blendedWithAcuerdo = false;
  if (ctx.confluencePct != null && Number.isFinite(ctx.confluencePct)) {
    blended = 0.62 * afterLoc + 0.38 * ctx.confluencePct;
    blendedWithAcuerdo = true;
  }

  return {
    scoreCombined: Math.round(clamp(blended, 0, 100) * 10) / 10,
    preAcuerdo: Math.round(combined * 10) / 10,
    afterLocation: Math.round(afterLoc * 10) / 10,
    locationMult: locMult,
    blendedWithAcuerdo,
    confluencePct: ctx.confluencePct,
  };
}

/** Tasa de acierto realista (misma curva que Python winrate_estimate, simplificada). */
function computeNewWinrate(ctx) {
  const rulesPct = ctx.rulesPct;
  if (rulesPct == null || rulesPct < 50) return null;

  const reverse = ctx.setupMode === 'reverse';
  const cap = reverse ? 65.1 : 74.0;
  const floor = 48.0;
  let wr = reverse
    ? 52.0 + (61.1 - 52.0) * clamp((rulesPct - 50) / 50, 0, 1)
    : 52.0 + (74.0 - 52.0) * clamp((rulesPct - 50) / 50, 0, 1);

  const notes = [`${Math.round(rulesPct)}% reglas`];

  if (ctx.direction === 'LONG' && ctx.premiumDiscount === 'PREMIUM') {
    const cut = ctx.setupMode === 'break' ? 12 : 7;
    wr -= cut;
    notes.push(`LONG en PREMIUM -${cut}`);
  } else if (ctx.direction === 'SHORT' && ctx.premiumDiscount === 'DISCOUNT') {
    const cut = ctx.setupMode === 'break' ? 12 : 7;
    wr -= cut;
    notes.push(`SHORT en DISCOUNT -${cut}`);
  }

  const label = String(ctx.confluenceLabel || '').toUpperCase();
  const cp = ctx.confluencePct;
  if (label === 'ALTA' || (cp != null && cp >= 75)) {
    wr += 2;
    notes.push('acuerdo ALTA +2');
  } else if (label === 'BAJA' || (cp != null && cp >= 25 && cp < 50)) {
    wr -= 8;
    notes.push('acuerdo BAJA -8');
  } else if (label === 'NULA' || (cp != null && cp < 25)) {
    wr -= 12;
    notes.push('acuerdo NULA -12');
  } else if (label === 'MEDIA' || (cp != null && cp >= 50 && cp < 75)) {
    wr -= 2;
    notes.push('acuerdo MEDIA -2');
  }

  wr = clamp(wr, floor, cap);
  const wrI = Math.round(wr);
  const srcTag = reverse ? 'E2 reversión BTC' : 'E1 BTC';
  return {
    winrate: `~${wrI}%`,
    winrateSource: `histórico ${srcTag} · ${notes.slice(0, 4).join('; ')}`,
  };
}

/**
 * Aplica recalc a un summary object. No muta si ya está en RECALC_VERSION
 * salvo que force=true (entonces usa BeforeRecalc como base).
 * @returns {{ summary: object, scoreCombined: number|null, changed: boolean, detail?: object }}
 */
function recalcSummaryProbabilidad(summary, { preview = null, flags = null, force = false } = {}) {
  const s =
    summary && typeof summary === 'object' ? { ...summary } : {};

  const already = s.scoreRecalcVersion === RECALC_VERSION;
  const base =
    already && s.scoreCombinedBeforeRecalc != null
      ? parseNum(s.scoreCombinedBeforeRecalc)
      : parseNum(s.scoreCombined);

  if (base == null) {
    return { summary: s, scoreCombined: null, changed: false };
  }
  if (already && !force) {
    return {
      summary: s,
      scoreCombined: parseNum(s.scoreCombined),
      changed: false,
    };
  }

  const ctx = extractRecalcContext(s, preview, flags);
  const result = computeNewProbabilidad(base, ctx);
  if (!result) {
    return { summary: s, scoreCombined: base, changed: false };
  }

  const before = already
    ? parseNum(s.scoreCombinedBeforeRecalc) ?? base
    : base;

  s.scoreCombinedBeforeRecalc = before;
  s.scoreCombined = result.scoreCombined;
  s.scoreRecalcVersion = RECALC_VERSION;
  s.scoreRecalcAt = new Date().toISOString();
  s.scoreRecalcMeta = {
    locationMult: result.locationMult,
    afterLocation: result.afterLocation,
    confluencePct: result.confluencePct,
    blendedWithAcuerdo: result.blendedWithAcuerdo,
    direction: ctx.direction,
    setupMode: ctx.setupMode,
    premiumDiscount: ctx.premiumDiscount,
  };

  // Actualiza barra chartScores "Probabilidad de éxito" si existe
  if (Array.isArray(s.chartScores)) {
    s.chartScores = s.chartScores.map((bar) => {
      if (/probabilidad de [eé]xito|combinado/i.test(bar.label || '')) {
        return { ...bar, value: result.scoreCombined };
      }
      return bar;
    });
  }

  const wr = computeNewWinrate(ctx);
  if (wr) {
    s.winrate = wr.winrate;
    s.winrateSource = wr.winrateSource;
  }

  const changed =
    Math.abs((parseNum(s.scoreCombined) ?? 0) - before) > 0.05 ||
    Boolean(wr);

  return {
    summary: s,
    scoreCombined: result.scoreCombined,
    changed,
    detail: result,
  };
}

module.exports = {
  RECALC_VERSION,
  extractRecalcContext,
  computeNewProbabilidad,
  computeNewWinrate,
  recalcSummaryProbabilidad,
  locationMultiplier,
};
