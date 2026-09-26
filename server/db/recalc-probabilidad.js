/**
 * Recalcula Probabilidad de éxito (scoreCombined) con la lógica v3:
 *  - penalización / bonificación ubicación (PD vs dirección, Break chase)
 *  - blend 62/38 con Acuerdo entre capas (confluencePct)
 *  - tasa de acierto alineada con Python winrate_estimate (bias + PD)
 *
 * El score histórico guardado = fusión pre-acuerdo (sin estos pasos).
 * Idempotente: guarda scoreCombinedBeforeRecalc + scoreRecalcVersion.
 */

const RECALC_VERSION = 'v3-bias-pd-acuerdo';

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrae dirección / setup / PD / confluencia / bias H1 desde summary (+ preview MD).
 * @param {Record<string, any>|null} summary
 * @param {string|null} preview
 * @param {Record<string, boolean>|null} flags
 */
function extractRecalcContext(summary, preview, flags) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const md = typeof preview === 'string' ? preview : '';

  let direction = null;
  const biasCli = String(s.bias || '').toLowerCase();
  if (flags?.bullish || /bullish|alcista|long/i.test(biasCli)) direction = 'LONG';
  if (flags?.bearish || /bearish|bajista|short/i.test(biasCli)) direction = 'SHORT';
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
      else if (raw.startsWith('EQUILIBRIO')) premiumDiscount = 'EQUILIBRIO';
    }
    if (!premiumDiscount) {
      const pd2 = md.match(
        /Premium\/Discount\s*\|\s*\*?\*?(PREMIUM|DISCOUNT|EQUILIBRIO)/i
      );
      if (pd2) premiumDiscount = pd2[1].toUpperCase();
    }
    if (!premiumDiscount) {
      const pd3 = md.match(/Premium\/Discount\s*\*\*(PREMIUM|DISCOUNT)/i);
      if (pd3) premiumDiscount = pd3[1].toUpperCase();
    }
  }
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

  // Bias H1 del mercado (no el CLI): Tendencia / bando mercado en MD
  let biasH1 = null;
  if (md) {
    const h1m =
      md.match(/Tendencia H1[^\n]*?\|\s*([✅❌])\s*\|\s*([^\n|]+)/i) ||
      md.match(/bando mercado[^\n]*?\*\*(BULLISH|BEARISH|NEUTRAL)\*\*/i) ||
      md.match(/\bH1\s*\*\*(BULLISH|BEARISH|NEUTRAL|Alcista|Bajista)\*\*/i);
    if (h1m) {
      const raw = String(h1m[2] || h1m[1] || '').toUpperCase();
      if (/BULL|ALCISTA/.test(raw)) biasH1 = 'BULLISH';
      else if (/BEAR|BAJISTA/.test(raw)) biasH1 = 'BEARISH';
      else if (/NEUTR/.test(raw)) biasH1 = 'NEUTRAL';
    }
    if (!biasH1) {
      const note = md.match(/Tendencia H1 alineada[^\n]*\|\s*[✅❌]\s*\|\s*([^\n|]+)/i);
      if (note) {
        const t = note[1].toUpperCase();
        if (/ALCISTA|BULL/.test(t)) biasH1 = 'BULLISH';
        else if (/BAJISTA|BEAR/.test(t)) biasH1 = 'BEARISH';
      }
    }
  }

  let modeBias = 'auto';
  if (flags?.bullish) modeBias = 'bullish';
  else if (flags?.bearish) modeBias = 'bearish';
  else if (/bullish|alcista/.test(biasCli)) modeBias = 'bullish';
  else if (/bearish|bajista/.test(biasCli)) modeBias = 'bearish';

  const rulesPct = parseNum(s.rulesPct);

  return {
    direction,
    setupMode,
    premiumDiscount,
    confluencePct,
    confluenceLabel,
    rulesPct,
    biasH1,
    modeBias,
  };
}

function locationMultiplier(direction, premiumDiscount, setupMode) {
  const mode = (setupMode || 'auto').toLowerCase();
  const pd = String(premiumDiscount || '').toUpperCase();
  if (direction === 'LONG' && pd === 'PREMIUM') {
    return mode === 'break' ? 0.72 : 0.88;
  }
  if (direction === 'SHORT' && pd === 'DISCOUNT') {
    return mode === 'break' ? 0.72 : 0.88;
  }
  if (direction === 'LONG' && pd === 'DISCOUNT') {
    return mode === 'reverse' ? 1.06 : 1.03;
  }
  if (direction === 'SHORT' && pd === 'PREMIUM') {
    return mode === 'reverse' ? 1.06 : 1.03;
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

/** Tasa de acierto realista (alineada con Python winrate_estimate v3). */
function computeNewWinrate(ctx) {
  const rulesPct = ctx.rulesPct;
  if (rulesPct == null || rulesPct < 50) return null;

  const reverse = ctx.setupMode === 'reverse';
  const mode = (ctx.setupMode || 'auto').toLowerCase();
  const cap = reverse ? 65.1 : 74.0;
  const floor = 48.0;
  let wr = reverse
    ? 52.0 + (61.1 - 52.0) * clamp((rulesPct - 50) / 50, 0, 1)
    : 52.0 + (74.0 - 52.0) * clamp((rulesPct - 50) / 50, 0, 1);

  const notesPriority = [];
  const notesTail = [`${Math.round(rulesPct)}% reglas`];
  const direction = ctx.direction;
  const pd = String(ctx.premiumDiscount || '').toUpperCase();

  // Premium / Discount vs dirección
  if (direction === 'LONG' && pd === 'PREMIUM') {
    const cut = mode === 'break' ? 12 : 7;
    const tag = mode === 'break' ? 'chase Break' : mode === 'reverse' ? 'E2 vs zona' : 'vs zona';
    wr -= cut;
    notesPriority.push(`LONG en PREMIUM -${cut} (${tag})`);
  } else if (direction === 'SHORT' && pd === 'DISCOUNT') {
    const cut = mode === 'break' ? 12 : 7;
    const tag = mode === 'break' ? 'chase Break' : mode === 'reverse' ? 'E2 vs zona' : 'vs zona';
    wr -= cut;
    notesPriority.push(`SHORT en DISCOUNT -${cut} (${tag})`);
  } else if (direction === 'LONG' && pd === 'DISCOUNT') {
    const boost = mode === 'reverse' ? 4 : 2;
    const tag = mode === 'reverse' ? 'E2 a favor' : 'zona a favor';
    wr += boost;
    notesPriority.push(`LONG en DISCOUNT +${boost} (${tag})`);
  } else if (direction === 'SHORT' && pd === 'PREMIUM') {
    const boost = mode === 'reverse' ? 4 : 2;
    const tag = mode === 'reverse' ? 'E2 a favor' : 'zona a favor';
    wr += boost;
    notesPriority.push(`SHORT en PREMIUM +${boost} (${tag})`);
  } else if (pd.startsWith('EQUILIBRIO')) {
    notesTail.push('EQUILIBRIO 0');
  }

  // Bias H1 / CLI
  const bias = String(ctx.biasH1 || '').toUpperCase();
  const modeBias = String(ctx.modeBias || 'auto').toLowerCase();
  if (direction === 'LONG' || direction === 'SHORT') {
    const conflictH1 =
      (direction === 'LONG' && bias === 'BEARISH') ||
      (direction === 'SHORT' && bias === 'BULLISH');
    const alignedH1 =
      (direction === 'LONG' && bias === 'BULLISH') ||
      (direction === 'SHORT' && bias === 'BEARISH');
    const conflictCli =
      (direction === 'LONG' && modeBias === 'bearish') ||
      (direction === 'SHORT' && modeBias === 'bullish');
    const alignedCli =
      (direction === 'LONG' && modeBias === 'bullish') ||
      (direction === 'SHORT' && modeBias === 'bearish');

    if (conflictH1) {
      wr -= 6;
      notesPriority.push(`H1 ${bias} vs ${direction} -6`);
    } else if (alignedH1) {
      wr += 4;
      notesPriority.push(`H1 ${bias} a favor +4`);
    } else if (conflictCli && (!bias || bias === 'NEUTRAL')) {
      wr -= 3;
      notesPriority.push(`CLI ${modeBias.toUpperCase()} vs ${direction} -3`);
    } else if (alignedCli && (!bias || bias === 'NEUTRAL')) {
      wr += 2;
      notesPriority.push(`CLI ${modeBias.toUpperCase()} a favor +2`);
    }
  }

  const label = String(ctx.confluenceLabel || '').toUpperCase();
  const cp = ctx.confluencePct;
  if (label === 'ALTA' || (cp != null && cp >= 75)) {
    wr += 2;
    notesPriority.push('acuerdo ALTA +2');
  } else if (label === 'BAJA' || (cp != null && cp >= 25 && cp < 50)) {
    wr -= 8;
    notesPriority.push('acuerdo BAJA -8');
  } else if (label === 'NULA' || (cp != null && cp < 25)) {
    wr -= 12;
    notesPriority.push('acuerdo NULA -12');
  } else if (label === 'MEDIA' || (cp != null && cp >= 50 && cp < 75)) {
    wr -= 2;
    notesPriority.push('acuerdo MEDIA -2');
  }

  wr = clamp(wr, floor, cap);
  const wrI = Math.round(wr);
  const srcTag = reverse ? 'E2 reversión BTC' : 'E1 BTC';
  const notes = [...notesPriority, ...notesTail].slice(0, 5);
  const winrateSource = `histórico ${srcTag} · ${notes.join('; ')}`;
  return {
    winrate: `~${wrI}%`,
    winrateSource,
    /** Texto completo para la columna del historial */
    winrateDisplay: `~${wrI}% — ${winrateSource}`,
    factors: notes,
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
  // Al migrar desde v2 (u otra), usar siempre la base pre-acuerdo si existe
  const base =
    s.scoreCombinedBeforeRecalc != null
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

  // Si venía de v2, el BeforeRecalc sigue siendo la base pre-acuerdo
  const ctx = extractRecalcContext(s, preview, flags);
  const result = computeNewProbabilidad(base, ctx);
  if (!result) {
    return { summary: s, scoreCombined: base, changed: false };
  }

  const before = already
    ? parseNum(s.scoreCombinedBeforeRecalc) ?? base
    : parseNum(s.scoreCombinedBeforeRecalc) ?? base;

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
    biasH1: ctx.biasH1,
    modeBias: ctx.modeBias,
  };

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
    s.winrate = wr.winrateDisplay;
    s.winrateSource = wr.winrateSource;
    s.winrateFactors = wr.factors;
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
