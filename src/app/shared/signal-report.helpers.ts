import type { HistoryMt5Real, PlanDetails, SignalSummary } from '../services/signals-api.service';

export type { ChecklistItem } from '../services/signals-api.service';

export interface KpiRow {
  campo: string;
  valor: string;
}

export interface InvestorExplainRow {
  campo: string;
  valor: string;
  significado: string;
}

export function chartHref(
  market: string,
  chartUrl?: string | null,
  chartPath?: string | null
): string | null {
  if (chartUrl) {
    const u = chartUrl.trim();
    if (u.startsWith('/') || /^https?:\/\//i.test(u)) return u;
  }
  if (chartUrl || chartPath) {
    return `/api/signals/chart?market=${encodeURIComponent(market || 'btc')}`;
  }
  return null;
}

/** Score combinado (0–100) desde summary o barra chartScores. */
export function resolveSuccessProbabilityPct(
  s: SignalSummary | null
): number | null {
  if (!s) return null;
  if (s.scoreCombined != null && Number.isFinite(s.scoreCombined)) {
    return s.scoreCombined;
  }
  const bar = s.chartScores?.find((b) =>
    /combinado|probabilidad de [eé]xito/i.test(b.label || '')
  );
  if (bar?.value != null && Number.isFinite(bar.value)) return bar.value;
  return null;
}

/**
 * Fila del bloque VEREDICTO: probabilidad de éxito (score combinado),
 * no estados wait/stop (NO_OPERAR, ESPERAR, etc.).
 */
export function verdictRows(s: SignalSummary | null): KpiRow[] {
  const pct = resolveSuccessProbabilityPct(s);
  if (pct == null) return [];
  return [{ campo: 'Probabilidad de éxito', valor: `${Math.round(pct)}%` }];
}

export function marketRows(s: SignalSummary | null): KpiRow[] {
  if (!s) return [];
  const rows: KpiRow[] = [];
  if (s.price) rows.push({ campo: 'Precio actual', valor: s.price });
  if (s.entryOptima) rows.push({ campo: 'Entrada sugerida', valor: s.entryOptima });
  if (s.plan) rows.push({ campo: 'Tipo de plan', valor: s.plan });
  return rows;
}

export function setupRows(s: SignalSummary | null): KpiRow[] {
  if (!s) return [];
  const rows: KpiRow[] = [];
  if (s.bias) rows.push({ campo: 'Dirección', valor: s.bias });
  if (s.twoM5) rows.push({ campo: 'Estructura (2M5)', valor: s.twoM5 });
  if (s.setup) rows.push({ campo: 'Tipo de setup', valor: s.setup });
  if (s.winrate) rows.push({ campo: 'Tasa de acierto', valor: s.winrate });
  if (s.impulso) rows.push({ campo: 'Impulso', valor: s.impulso });
  return rows;
}

export function scoreKpiRows(s: SignalSummary | null): KpiRow[] {
  if (!s) return [];
  const rows: KpiRow[] = [];
  if (s.rulesPct != null) {
    rows.push({ campo: 'Cumplimiento de reglas', valor: `${s.rulesPct}%` });
  }
  if (s.mlPct != null) {
    rows.push({ campo: 'Modelo automático (ML)', valor: `${s.mlPct}%` });
  }
  if (s.confluencePct != null) {
    const label = s.confluenceLabel ? `${s.confluenceLabel} · ` : '';
    rows.push({ campo: 'Acuerdo entre capas', valor: `${label}${s.confluencePct}%` });
  }
  // scoreCombined vive en el bloque VEREDICTO como «Probabilidad de éxito»
  if (s.scoreExtended != null) {
    rows.push({ campo: 'Nota extendida', valor: `${s.scoreExtended}%` });
  }
  return rows;
}

/** Fila de la tabla unificada de la Vista rápida (Scores + confluencias por capa). */
export interface RapidaScoreRow {
  /** Nombre en lenguaje natural. */
  concepto: string;
  valor: string;
  detalle: string;
  /** true = ✓ a favor · false = ✗ en contra · null = informativa. */
  ok: boolean | null;
  /** Nombre técnico original (tooltip). */
  tecnico?: string;
  /** Fila final con la probabilidad de ganar. */
  final?: boolean;
}

export interface RapidaScoreGroup {
  titulo: string;
  rows: RapidaScoreRow[];
}

const norm = (t: string | null | undefined): string =>
  (t || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

/** Clave de concepto para detectar la misma medida con nombres distintos (Confluencia ≈ Acuerdo entre capas). */
function scoreConceptKey(label: string | null | undefined): string {
  const t = norm(label);
  if (/^(acuerdo( entre capas)?|confluencia)$/.test(t)) return 'acuerdo';
  if (/^(rules?( e1)?|reglas|cumplimiento de reglas)$/.test(t)) return 'reglas';
  if (/^(ml|modelo automatico \(ml\)|ml tabular( \(gated\))?)$/.test(t)) return 'ml';
  if (/^(score ext\.?|nota extendida|nota ampliada|rules extendidas( \(10\))?)$/.test(t)) {
    return 'extendida';
  }
  if (/^neural galeria/.test(t)) return 'neural';
  if (/^crt coherence/.test(t)) return 'crt';
  if (/^(penalizacion|bonificacion) ubicacion/.test(t)) return 'ubicacion';
  if (/^penalizacion direccion/.test(t)) return 'direccion';
  if (/^e2 turtle/.test(t)) return 'e2';
  if (/^fusion heuristica/.test(t)) return 'fusion-anterior';
  if (/^capas ml\/neural/.test(t)) return 'capas-ia';
  if (/^ev por operacion/.test(t)) return 'ev';
  return t;
}

const NATURAL_SCORE_NAMES: Record<string, string> = {
  reglas: 'Reglas del plan cumplidas',
  ml: 'Predicción del modelo de datos',
  acuerdo: 'Coincidencia entre los análisis',
  extendida: 'Chequeo ampliado (10 puntos)',
  neural: 'Parecido con operaciones pasadas',
  crt: 'Precio respeta el rango de ayer',
  ubicacion: 'Precio en zona favorable',
  direccion: 'Tendencia de 1 hora a favor',
  e2: 'Patrón de giro (E2)',
  'fusion-anterior': 'Cálculo anterior (referencia)',
  'capas-ia': 'IA incluida en el cálculo',
  ev: 'Ganancia esperada por operación',
};

/** Nombre entendible para alguien sin jerga de trading. */
export function naturalScoreName(label: string | null | undefined): string {
  return NATURAL_SCORE_NAMES[scoreConceptKey(label)] || (label || '').trim() || '—';
}

const OK_THRESHOLD: Record<string, number> = {
  extendida: 70,
  ml: 55,
  acuerdo: 50,
  neural: 60,
};

/** ✓ / ✗ / null para una fila de score según su valor. */
export function scoreRowStatus(label: string | null | undefined, valor: string | null | undefined): boolean | null {
  const key = scoreConceptKey(label);
  if (key === 'fusion-anterior' || key === 'capas-ia') return null;
  const v = String(valor || '').trim().toLowerCase();
  if (!v || v === '—' || v === 'n/d') return null;
  if (v === 'pass') return true;
  if (v === 'fail') return false;
  const mult = /^[×x]\s*(\d+(?:[.,]\d+)?)/.exec(v);
  if (mult) {
    const m = Number(mult[1].replace(',', '.'));
    if (m === 1) return null;
    return m > 1;
  }
  const ev = /^([+-]?\d+(?:[.,]\d+)?)\s*r$/.exec(v);
  if (ev) return Number(ev[1].replace(',', '.')) > 0;
  const frac = /(\d+)\s*\/\s*(\d+)/.exec(v);
  const pct = frac ? (Number(frac[1]) / Number(frac[2])) * 100 : firstPercent(v)?.value;
  if (pct == null || !Number.isFinite(pct)) return null;
  return pct >= (OK_THRESHOLD[key] ?? 60);
}

/** Fila final: probabilidad de ganar frente al equilibrio del R:R. */
export function winProbabilityRow(s: SignalSummary | null): RapidaScoreRow | null {
  const pct = resolveSuccessProbabilityPct(s);
  if (pct == null) return null;
  const rr = parseRewardMultiple(s?.planDetails?.rr) ?? 2;
  const breakeven = 100 / (1 + rr);
  const range = /80%:\s*(\d+)\s*[–-]\s*(\d+)%/.exec(String(s?.winrate || ''));
  const detalle = [
    `≈ ${Math.round(pct / 10)} de cada 10 operaciones así ganan`,
    `equilibrio ${Math.round(breakeven)}% con R:R 1:${rr}`,
    range ? `rango ${range[1]}–${range[2]}%` : '',
  ].filter(Boolean).join(' · ');
  return {
    concepto: 'Probabilidad de ganar la operación',
    valor: `${Math.round(pct)}%`,
    detalle,
    ok: pct > breakeven + 5,
    tecnico: 'Probabilidad de éxito',
    final: true,
  };
}

function joinDetail(weight: string | null | undefined, note: string | null | undefined): string {
  const w = (weight || '').trim();
  return [w ? `Peso ${w}` : '', (note || '').trim()].filter(Boolean).join(' · ');
}

/**
 * Tabla unificada de la Vista rápida: «Resumen» (reglas, ML, acuerdo, chequeo ampliado)
 * + «Detalle por análisis» (scorecard multicapa) + «Resultado» (probabilidad de ganar).
 * - Nombres en lenguaje natural; el técnico queda en `tecnico`.
 * - Si una capa del scorecard es la misma medida que un score (p. ej. Rules E1 ≈ reglas),
 *   su peso/nota se fusiona en la fila del score en vez de añadir otra.
 * - Si no hay scorecard, las barras (chartScores) aportan las filas que falten.
 */
export function rapidaScoreGroups(s: SignalSummary | null): RapidaScoreGroup[] {
  if (!s) return [];
  const scores: RapidaScoreRow[] = scoreKpiRows(s).map((r) => ({
    concepto: naturalScoreName(r.campo),
    valor: r.valor,
    detalle: '',
    ok: scoreRowStatus(r.campo, r.valor),
    tecnico: r.campo,
  }));
  const scoreByKey = new Map(scores.map((r) => [scoreConceptKey(r.tecnico), r]));

  const layers: RapidaScoreRow[] = [];
  const addLayer = (tecnico: string, valor: string, detalle: string): void => {
    const dup = scoreByKey.get(scoreConceptKey(tecnico));
    if (dup) {
      if (detalle && !dup.detalle) dup.detalle = detalle;
      return;
    }
    const concepto = naturalScoreName(tecnico);
    if (layers.some((l) => norm(l.concepto) === norm(concepto))) return;
    layers.push({ concepto, valor, detalle, ok: scoreRowStatus(tecnico, valor), tecnico });
  };

  if (s.scorecard?.length) {
    for (const row of s.scorecard) {
      if (isCombinedScoreLabel(row.label)) continue;
      const valor = row.raw || (row.value != null ? `${row.value}%` : '—');
      addLayer(displayScoreLabel(row.label), valor, joinDetail(row.weight, row.note));
    }
  } else {
    for (const bar of s.chartScores || []) {
      if (isCombinedScoreLabel(bar.label)) continue;
      const valor = bar.value != null ? `${Math.round(bar.value * 10) / 10}%` : bar.raw || '—';
      addLayer(displayScoreLabel(bar.label), valor, '');
    }
  }

  const groups: RapidaScoreGroup[] = [];
  if (scores.length) groups.push({ titulo: 'Resumen', rows: scores.map((r) => ({ ...r, detalle: r.detalle || '—' })) });
  if (layers.length) {
    groups.push({
      titulo: 'Detalle por análisis',
      rows: layers.map((r) => ({ ...r, detalle: r.detalle || '—' })),
    });
  }
  const finalRow = groups.length ? winProbabilityRow(s) : null;
  if (finalRow) groups.push({ titulo: 'Resultado', rows: [finalRow] });
  return groups;
}

export function hasRapidaScores(s: SignalSummary | null): boolean {
  return rapidaScoreGroups(s).length > 0;
}

export function hasPlanMatrix(s: SignalSummary | null): boolean {
  const p = s?.planDetails;
  return !!(p && (p.entry || p.sl || p.tp || p.rr));
}

export function hasMarketPlan(s: SignalSummary | null): boolean {
  return marketRows(s).length > 0 || hasPlanMatrix(s);
}

export function hasScoresCard(s: SignalSummary | null): boolean {
  return (
    scoreKpiRows(s).length > 0 ||
    !!(s?.chartScores?.length || s?.scorecard?.length)
  );
}

export function hasChecklistsCard(s: SignalSummary | null): boolean {
  return !!(s?.rulesReview?.length || s?.checklist2M5?.length || s?.checklistE1?.length);
}

const RULE_GRADE_CLASS: Record<string, string> = {
  '✓✓': 'grade-strong',
  '✓': 'grade-ok',
  '~': 'grade-neutral',
  '✗': 'grade-bad',
  '✗✗': 'grade-critical',
  '·': 'grade-info',
};

export function ruleGradeClass(grade: string | null | undefined): string {
  return RULE_GRADE_CLASS[String(grade || '').trim()] || 'grade-info';
}

export function hasDetalleAdicional(
  s: SignalSummary | null,
  preview?: string | null
): boolean {
  return !!(s?.volume || s?.redFlags?.length || preview);
}

/** Primer «NN%» / «NN,N %» del texto, sin regex con backtracking. */
export function firstPercent(
  text: string
): { value: number; start: number; end: number } | null {
  let idx = text.indexOf('%');
  while (idx !== -1) {
    let j = idx - 1;
    while (j >= 0 && text[j] === ' ') j--;
    const numEnd = j + 1;
    while (j >= 0 && /[\d.,]/.test(text[j])) j--;
    const numStr = text.slice(j + 1, numEnd).replace(',', '.');
    const value = Number(numStr);
    if (/\d/.test(numStr) && Number.isFinite(value)) {
      return { value, start: j + 1, end: idx + 1 };
    }
    idx = text.indexOf('%', idx + 1);
  }
  return null;
}

export function verdictTone(v: string | null | undefined): string {
  const raw = String(v || '');
  const t = raw.toUpperCase();
  // Porcentaje (Probabilidad de éxito) — no es un badge wait/stop
  const pct = firstPercent(raw);
  if (pct && !raw.slice(0, pct.start).trim() && !raw.slice(pct.end).trim()) {
    return successProbabilityTone(pct.value);
  }
  if (/NO_OPERAR|NO OPERAR|ESPERAR|WAIT/.test(t)) return 'warn';
  if (/SHORT/.test(t) && !/NO_/.test(t)) return 'bearish';
  if (/LONG/.test(t) && !/NO_/.test(t)) return 'bullish';
  if (/OPERAR|GO/.test(t) && !/NO_/.test(t)) return 'ok';
  return '';
}

/** Tone del bloque Veredicto: prioriza score combinado sobre strings wait/stop. */
export function verdictSectionTone(s: SignalSummary | null): string {
  const pct = resolveSuccessProbabilityPct(s);
  if (pct != null) return successProbabilityTone(pct);
  return verdictTone(s?.verdict);
}

export function successProbabilityTone(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '';
  if (pct >= 70) return 'ok';
  if (pct >= 45) return '';
  return 'warn';
}

/**
 * Tone para texto de tasa de acierto (~82% — patrón ganador similar · …).
 * Extrae el primer % del string; no usa veredictos wait/stop.
 */
export function hitRateTone(winrate: string | null | undefined): string {
  const m = firstPercent(String(winrate || ''));
  if (!m) return '';
  return successProbabilityTone(m.value);
}

/** Factor individual del desglose de tasa (bias / PD / acuerdo / patrón). */
export interface HitRateFactor {
  label: string;
  /** Delta numérico si se detecta (+3, -7); null si es informativo. */
  delta: number | null;
  kind: 'pd' | 'bias' | 'acuerdo' | 'patron' | 'reglas' | 'other';
}

export interface HitRateAnalysis {
  /** Porcentaje principal (~48%). */
  pctLabel: string;
  pct: number | null;
  /** Fuente corta: E2 reversión BTC / E1 BTC. */
  source: string | null;
  factors: HitRateFactor[];
  /** Texto crudo si no se pudo parsear. */
  raw: string;
}

function classifyHitFactor(label: string): HitRateFactor['kind'] {
  const t = label.toLowerCase();
  if (/premium|discount|equilibrio|zona|chase/.test(t)) return 'pd';
  if (/\bh1\b|\bcli\b|bias|bullish|bearish|a favor|vs (long|short)/.test(t))
    return 'bias';
  if (/acuerdo/.test(t)) return 'acuerdo';
  if (/patron|patrón|win|loss|mixtos/.test(t)) return 'patron';
  if (/reglas|fusi[oó]n|ancla|hist[oó]rico/.test(t)) return 'reglas';
  return 'other';
}

/**
 * Separa «~48% — histórico E2 · SHORT en DISCOUNT -7; acuerdo BAJA -8»
 * en % + chips de factores (bias / premium / discount / acuerdo).
 */
export function parseHitRateAnalysis(
  winrate: string | null | undefined
): HitRateAnalysis {
  const raw = String(winrate || '').trim();
  if (!raw || raw === '—' || raw === '-') {
    return { pctLabel: '—', pct: null, source: null, factors: [], raw };
  }

  const pctM = firstPercent(raw);
  const pct = pctM ? pctM.value : null;
  const pctLabel = pct == null ? raw.slice(0, 12) : `~${Math.round(pct)}%`;

  let rest = pctM ? raw.slice(pctM.end).replace(/^\s*[—–-]+\s*/, '') : raw;

  const src = splitHitRateSource(rest);
  const source = src.source;
  rest = src.rest;

  const factors: HitRateFactor[] = rest
    .split(/[;|]/)
    .map((c) => c.replace(/^\s*·\s*/, '').trim())
    .filter((c) => c && !/^hist[oó]rico/i.test(c))
    .map((chunk) => ({
      label: chunk,
      delta: parseFactorDelta(chunk),
      kind: classifyHitFactor(chunk),
    }));

  return { pctLabel, pct, source, factors, raw };
}

/** «histórico E2 reversión BTC · resto» → fuente + resto tras el separador. */
function splitHitRateSource(text: string): { source: string | null; rest: string } {
  const hm = /hist[oó]rico\s/i.exec(text);
  if (!hm) return { source: null, rest: text };
  const after = text.slice(hm.index + hm[0].length);
  const sepIdx = after.search(/[·|;]/);
  if (sepIdx === -1) return { source: after.trim() || null, rest: '' };
  return { source: after.slice(0, sepIdx).trim() || null, rest: after.slice(sepIdx + 1) };
}

/** Delta «-7», «+ 3», «−8 (…)» al final del chunk o antes de un paréntesis. */
function parseFactorDelta(chunk: string): number | null {
  for (const m of chunk.matchAll(/[-+−]\s*\d+(?:[.,]\d+)?/g)) {
    const tail = chunk.slice((m.index ?? 0) + m[0].length).trimStart();
    if (tail && !tail.startsWith('(')) continue;
    const n = Number(m[0].replace('−', '-').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Resumen corto para columna Probabilidad (meta de recalc o tags PD). */
export function probabilityHint(item: {
  tags?: Array<{ name?: string } | string> | null;
  winrate?: string | null;
}): string | null {
  const analysis = parseHitRateAnalysis(item.winrate);
  const findKind = (k: HitRateFactor['kind']) => analysis.factors.find((f) => f.kind === k);
  const parts = [
    pdTagName(item.tags) ?? pdFromFactor(findKind('pd')),
    biasOrAcuerdoHint(findKind('bias'), findKind('acuerdo')),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : null;
}

function pdTagName(tags: Array<{ name?: string } | string> | null | undefined): string | null {
  for (const t of tags || []) {
    const name = String(typeof t === 'string' ? t : t?.name || '').toUpperCase();
    if (name === 'PREMIUM' || name === 'DISCOUNT') return name;
  }
  return null;
}

function pdFromFactor(pd: HitRateFactor | undefined): string | null {
  const m = pd ? /\b(PREMIUM|DISCOUNT|EQUILIBRIO)\b/i.exec(pd.label) : null;
  return m ? m[1].toUpperCase() : null;
}

function biasOrAcuerdoHint(
  bias: HitRateFactor | undefined,
  acuerdo: HitRateFactor | undefined
): string | null {
  if (bias) {
    const m = /\b(BULLISH|BEARISH|NEUTRAL|CLI\s+\w+)\b/i.exec(bias.label);
    return m ? m[1].toUpperCase().replace(/\s+/, ' ') : null;
  }
  const m = acuerdo ? /acuerdo\s+(\w+)/i.exec(acuerdo.label) : null;
  return m ? `acuerdo ${m[1]}` : null;
}

const KIND_TITLE: Record<HitRateFactor['kind'], string> = {
  pd: 'Premium / Discount',
  bias: 'Bias H1 / CLI',
  acuerdo: 'Acuerdo entre capas',
  patron: 'Patrón similar',
  reglas: 'Reglas / ancla',
  other: 'Factor',
};

/** «+3» / «-7» o null. */
function formatDelta(delta: number | null): string | null {
  if (delta == null) return null;
  return delta > 0 ? `+${delta}` : String(delta);
}

function withDelta(text: string, delta: string | null): string {
  return delta ? `${text} Ajuste ${delta} pts.` : text;
}

type FactorRule = [RegExp, string];

/** Primera regla cuyo patrón coincide → texto + ajuste; si ninguna, fallback. */
function explainByRules(
  t: string,
  delta: string | null,
  rules: FactorRule[],
  fallback: string
): string {
  const hit = rules.find(([re]) => re.test(t));
  return withDelta(hit ? hit[1] : fallback, delta);
}

function explainPd(t: string, raw: number | null, delta: string | null): string {
  if (/chase|vs zona|(premium|discount)[^-]*-/.test(t) || (raw != null && raw < 0)) {
    return withDelta('Zona en contra (ICT: long en discount / short en premium).', delta);
  }
  if (/a favor|\+/.test(t) || (raw != null && raw > 0)) {
    return withDelta('Zona a favor del setup.', delta);
  }
  if (t.includes('equilibrio')) return 'Precio en equilibrio: sin ajuste por ubicación.';
  return withDelta('Ubicación Premium/Discount.', delta);
}

function explainBias(t: string, raw: number | null, delta: string | null): string {
  if (/a favor|alinead/.test(t) || (raw != null && raw > 0)) {
    return withDelta('Bias alineado con la dirección del trade.', delta);
  }
  if (/vs |conflicto|contra/.test(t) || (raw != null && raw < 0)) {
    return withDelta('Bias en conflicto con la dirección.', delta);
  }
  if (t.includes('neutral')) return 'H1 neutral: no suma ni resta por bias.';
  return withDelta('Sesgo direccional.', delta);
}

const ACUERDO_RULES: FactorRule[] = [
  [/alta/, 'Capas alineadas (acuerdo ALTA).'],
  [/baja|nula/, 'Poco acuerdo entre capas.'],
  [/media/, 'Acuerdo medio entre capas.'],
];

const PATRON_RULES: FactorRule[] = [
  [/win/, 'Galería: patrón ganador similar.'],
  [/loss/, 'Galería: patrón perdedor similar.'],
  [/mixtos/, 'Galería mixta WIN/LOSS.'],
];

function explainReglas(t: string, label: string): string {
  if (t.includes('reglas')) return 'Base de la curva: % de reglas E1/E2 cumplidas.';
  if (/fusi[oó]n|ancla/.test(t)) return 'Ancla suave hacia la Probabilidad de éxito (fusión).';
  return label;
}

/** Explicación corta de un factor del desglose (para tooltip). */
export function explainHitFactor(factor: HitRateFactor): string {
  const t = factor.label.toLowerCase();
  const delta = formatDelta(factor.delta);
  switch (factor.kind) {
    case 'pd':
      return explainPd(t, factor.delta, delta);
    case 'bias':
      return explainBias(t, factor.delta, delta);
    case 'acuerdo':
      return explainByRules(t, delta, ACUERDO_RULES, 'Acuerdo entre capas.');
    case 'patron':
      return explainByRules(t, delta, PATRON_RULES, 'Patrón histórico similar.');
    case 'reglas':
      return explainReglas(t, factor.label);
    default:
      return delta ? `${factor.label} (${delta})` : factor.label;
  }
}

/**
 * Tooltip multilínea para la columna Tasa de acierto.
 * Explica % + cada factor (bias, PD, acuerdo…).
 */
export function isCalibratedWinrate(winrate: string | null | undefined): boolean {
  return /calibrad[oa] walk-forward|tasa base \(modelo sin ventaja OOS\)/i.test(String(winrate || ''));
}

/** Lectura frente a la tasa base del motor (~46% BTC E1), no frente a umbrales fijos. */
export function calibratedBandLabel(pct: number): string {
  if (pct >= 52) return 'por encima de la media del motor';
  if (pct >= 42) return 'en la media del motor';
  return 'por debajo de la media del motor';
}

export function hitRateTooltip(winrate: string | null | undefined): string {
  const a = parseHitRateAnalysis(winrate);
  if (!a.raw || a.pct == null) {
    return a.raw && a.raw !== '—' ? a.raw : 'Sin tasa de acierto estimada.';
  }
  const pct = a.pct;
  if (isCalibratedWinrate(a.raw)) {
    return [
      `Probabilidad calibrada: ${a.pctLabel} — ${calibratedBandLabel(pct)}`,
      `≈ ${Math.round(pct / 10)} de cada 10 señales parecidas tocaron TP antes que SL (replay histórico).`,
      '',
      a.raw,
      '',
      'Modelo logístico validado walk-forward: RSI vs dirección, premium/discount,',
      '2 velas M5 y coherencia CRT. El rango 80% indica la incertidumbre del estimado.',
      'EV ya descuenta el costo estimado por operación.',
    ].join('\n');
  }
  const factorLines = a.factors.length
    ? a.factors.flatMap((f) => [
        `• ${KIND_TITLE[f.kind]}: ${f.label}`,
        `  ${explainHitFactor(f)}`,
      ])
    : ['• Solo base histórica del setup (sin ajustes).'];
  return [
    `Tasa de acierto estimada: ${a.pctLabel} — ${hitRateBandLabel(pct)}`,
    `≈ ${Math.round(pct / 10)} de cada 10 setups como este llegaron a TP antes que a SL.`,
    ...(a.source ? [`Fuente: histórico ${a.source}`] : []),
    '',
    'Cómo se llegó al %:',
    ...factorLines,
    '',
    `Con R:R 1:2 el equilibrio es ~34%. Esperanza ≈ ${formatExpectancyR(pct)} por trade.`,
    'Rango realista 48–74%. No es la Probabilidad de ESTA señal.',
  ].join('\n');
}

/** Lectura cualitativa de la tasa (48–74% es el rango realista del motor). */
export function hitRateBandLabel(pct: number): string {
  if (pct >= 65) return 'setup sólido';
  if (pct >= 55) return 'setup aceptable';
  return 'setup débil';
}

/** Esperanza en R con R:R 1:2: p·2 − (1−p)·1. */
export function formatExpectancyR(pct: number): string {
  const p = pct / 100;
  const e = Math.round((p * 2 - (1 - p)) * 100) / 100;
  return `${e >= 0 ? '+' : ''}${e.toFixed(2)}R`;
}

/** Tooltip de la cabecera de columna «Tasa de acierto». */
export const HIT_RATE_COLUMN_TOOLTIP = [
  'Tasa de acierto = % histórico estimado de setups parecidos que tocaron TP antes que SL.',
  '',
  'Señales nuevas (BTC E1): probabilidad calibrada walk-forward sobre el replay del motor,',
  'con rango 80% y EV en R. Media real del motor ≈ 46%; rango típico 33–62%.',
  '',
  'Señales anteriores (heurística, sin calibrar) se calculaban así:',
  '• Base: % de reglas E1/E2 cumplidas (curva histórica del setup).',
  '• Ajuste por ubicación Premium/Discount (long en discount / short en premium suman; al revés restan).',
  '• Ajuste por acuerdo entre capas (ALTA suma, BAJA/NULA resta).',
  '• Ajuste por bias H1 y por patrones WIN/LOSS similares de la galería.',
  '• Acotada a 48–74% para no inflarla.',
  '',
  'Lectura: <55% débil · 55–64% aceptable · ≥65% sólido.',
  'Con R:R 1:2 basta ~34% para no perder dinero.',
  '',
  'Diferencia con Probabilidad: la Tasa mide el TIPO de setup (histórico);',
  'la Probabilidad puntúa ESTA señal concreta (capas + ubicación).',
].join('\n');

/**
 * Tooltip para Probabilidad de éxito (score combinado + contexto PD/bias).
 */
export function probabilityTooltip(item: {
  scoreCombined?: number | null;
  tags?: Array<{ name?: string } | string> | null;
  winrate?: string | null;
}): string {
  const pct =
    item.scoreCombined != null && Number.isFinite(Number(item.scoreCombined))
      ? `${Math.round(Number(item.scoreCombined) * 10) / 10}%`
      : null;
  if (!pct) return 'Sin Probabilidad de éxito calculada.';

  if (isCalibratedWinrate(item.winrate)) {
    return [
      `Probabilidad de éxito: ${pct} (calibrada)`,
      '',
      String(item.winrate || ''),
      '',
      'ML / Neural solo entran si mejoran el Brier fuera de muestra.',
    ].join('\n');
  }

  const lines: string[] = [
    `Probabilidad de éxito: ${pct}`,
    '',
    'Score combinado (capas Rules/ML/Neural/CRT)',
    '+ ubicación Premium/Discount',
    '+ blend 62/38 con Acuerdo entre capas.',
  ];

  const hint = probabilityHint(item);
  if (hint) lines.push('', `Contexto: ${hint}`);

  const a = parseHitRateAnalysis(item.winrate);
  const relevant = (['pd', 'bias', 'acuerdo'] as const)
    .map((k) => a.factors.find((f) => f.kind === k))
    .filter((f): f is HitRateFactor => !!f);
  if (relevant.length) {
    lines.push(
      '',
      'Factores relevantes:',
      ...relevant.map((f) => `• ${f.label} — ${explainHitFactor(f)}`)
    );
  }

  return lines.join('\n');
}

/** Etiqueta de capa/score: Combinado → Probabilidad de éxito. */
export function displayScoreLabel(label: string | null | undefined): string {
  const t = (label || '').trim();
  if (/score\s*combinado|^combinado$/i.test(t)) return 'Probabilidad de éxito';
  return t || '—';
}

export function isCombinedScoreLabel(label: string | null | undefined): boolean {
  return /combinado|probabilidad de [eé]xito/i.test(label || '');
}

/** Tone visual para bias: bullish=verde, bearish=rojo, auto/neutro=muted. */
export type BiasTone = 'bullish' | 'bearish' | 'neutral' | '';

export function biasTone(value: string | null | undefined): BiasTone {
  const t = (value || '').trim().toLowerCase();
  if (!t) return '';
  if (/^(auto|neutr(?:al|o)?|sin forzar|none|n\/a|—|-)$/i.test(t)) return 'neutral';
  if (/bearish|bajista|\bbear\b/.test(t)) return 'bearish';
  if (/bullish|alcista|\bbull\b/.test(t)) return 'bullish';
  if (/auto|neutr|sin forzar/.test(t)) return 'neutral';
  return '';
}

/** Etiqueta corta para grids (alcista / bajista / default). */
export function biasLabel(value: string | null | undefined): string {
  const tone = biasTone(value);
  if (tone === 'bullish') return 'alcista';
  if (tone === 'bearish') return 'bajista';
  if (tone === 'neutral') return 'default';
  return '—';
}

/**
 * Bias elegido en la corrida: flags del job (prioridad) o summary.bias.
 * Usado en historial list/detail.
 */
export function resolveRunBias(
  flags?: Record<string, boolean> | null,
  summaryBias?: string | null
): string | null {
  if (flags?.['bullish']) return 'bullish';
  if (flags?.['bearish']) return 'bearish';
  const fromSummary = (summaryBias || '').trim();
  if (fromSummary) return fromSummary;
  if (flags && ('bullish' in flags || 'bearish' in flags)) return 'auto';
  return null;
}

export function investorVerdictTitle(s: SignalSummary | null): string {
  const v = (s?.verdict || '').toUpperCase();
  if (/NO_OPERAR|NO OPERAR/.test(v)) return 'No operar ahora';
  if (/ESPERAR|WAIT/.test(v)) return 'Esperar confirmación';
  if (/SHORT/.test(v) && !/NO_/.test(v)) return 'Hay señal de venta (corto)';
  if (/LONG/.test(v) && !/NO_/.test(v)) return 'Hay señal de compra (largo)';
  if (/OPERAR|GO/.test(v) && !/NO_/.test(v)) return 'Hay señal de entrada';
  return s?.verdict || 'Sin decisión todavía';
}

export function investorVerdictExplain(s: SignalSummary | null): string {
  const v = (s?.verdict || '').toUpperCase();
  if (/NO_OPERAR|NO OPERAR/.test(v)) {
    return 'Las condiciones no favorecen abrir una operación. No es una señal de compra ni de venta.';
  }
  if (/ESPERAR|WAIT/.test(v)) {
    return 'La idea aún no está lista: faltan confirmaciones. Mejor no entrar solo por impulso.';
  }
  if (/SHORT/.test(v) && !/NO_/.test(v)) {
    return 'El sistema ve una oportunidad a la baja. Si operas, sigue el plan (entrada, stop y objetivo).';
  }
  if (/LONG/.test(v) && !/NO_/.test(v)) {
    return 'El sistema ve una oportunidad al alza. Si operas, sigue el plan (entrada, stop y objetivo).';
  }
  if (/OPERAR|GO/.test(v) && !/NO_/.test(v)) {
    return 'El sistema ve una oportunidad. Si decides operar, sigue el plan de entrada, stop y objetivo.';
  }
  return 'Cuando haya un reporte, aquí verás en lenguaje simple qué conviene hacer.';
}

export function investorActionHint(s: SignalSummary | null): string {
  const v = (s?.verdict || '').toUpperCase();
  if (/NO_OPERAR|NO OPERAR|ESPERAR|WAIT/.test(v)) {
    return 'Qué hacer: no entrar. Espera una idea más clara.';
  }
  if (/OPERAR|LONG|SHORT|GO/.test(v) && !/NO_/.test(v)) {
    return 'Qué hacer: entra solo si entiendes y aceptas el riesgo del plan.';
  }
  return 'Ejecuta una señal o recarga el último reporte para ver la recomendación.';
}

export type RiskHeat = 'none' | 'cool' | 'warm' | 'hot';

export interface InvestorRiskCard {
  active: boolean;
  heat: RiskHeat;
  /** 0–100: más alto = más “calor” (peor relación o más riesgo relativo). */
  barPct: number;
  heatLabel: string;
  riskRaw: string | null;
  riskNumber: number | null;
  rrRaw: string | null;
  rewardMultiple: number | null;
  vsPricePct: number | null;
  title: string;
  lead: string;
  bullets: string[];
  tip: string | null;
}

function parseFirstNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(String(raw).replace(',', '.'));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Interpreta R:R tipo "1:2.5", "2.5", "1 a 3". Devuelve múltiplo de recompensa. */
export function parseRewardMultiple(rr: string | null | undefined): number | null {
  if (!rr) return null;
  const t = String(rr).trim().toLowerCase().replace(',', '.');
  const ratio = splitRatio(t);
  if (ratio) {
    const [a, b] = ratio;
    if (a === 0) return null;
    // "1:2" = arriesgo 1 para ganar 2 → múltiplo 2
    // Si viene "2:1" raro, tomamos max/min para no invertir mal si a>b
    return b >= a ? b / a : a / b;
  }
  const n = parseFirstNumber(t);
  return n != null && n > 0 ? n : null;
}

/** «1:2», «1/3», «1 a 3» → [1, 2]; null si no hay dos números. */
function splitRatio(t: string): [number, number] | null {
  const parts = t.split(/[:/]|(?<=\d)\s*a\s*(?=\d)/);
  if (parts.length < 2) return null;
  const a = parseFirstNumber(parts[0]);
  const b = parseFirstNumber(parts[1]);
  return a != null && b != null ? [Math.abs(a), Math.abs(b)] : null;
}

function heatFromRewardMultiple(mult: number): { heat: RiskHeat; barPct: number; label: string } {
  // Escala visual: Fresco 0–33 · Templado 33–66 · Caliente 66–100
  // Más premio (R:R alto) → más a la izquierda (fresco).
  if (mult >= 2.2) {
    const t = Math.min(1, Math.max(0, (mult - 2.2) / 0.5));
    return { heat: 'cool', barPct: Math.round(33 - t * 25), label: 'Fresco' };
  }
  if (mult >= 1.4) {
    const t = (2.2 - mult) / 0.8; // 2.2→0 · 1.4→1
    return { heat: 'warm', barPct: Math.round(33 + t * 33), label: 'Templado' };
  }
  const t = Math.min(1, Math.max(0, (1.4 - mult) / 0.6));
  return { heat: 'hot', barPct: Math.round(66 + t * 34), label: 'Caliente' };
}

function heatFromPricePct(pct: number): { heat: RiskHeat; barPct: number; label: string } {
  // % del precio entre entrada y stop — más % → más caliente (derecha).
  if (pct < 0.35) {
    const t = Math.max(0, pct) / 0.35;
    return { heat: 'cool', barPct: Math.round(8 + t * 25), label: 'Fresco' };
  }
  if (pct < 0.9) {
    const t = (pct - 0.35) / 0.55;
    return { heat: 'warm', barPct: Math.round(33 + t * 33), label: 'Templado' };
  }
  const t = Math.min(1, (pct - 0.9) / 0.9);
  return { heat: 'hot', barPct: Math.round(66 + t * 34), label: 'Caliente' };
}

/** Ángulo de aguja del gauge (180° = fresco/izq → 0° = caliente/der). */
export function riskGaugeNeedle(barPct: number): {
  x: number;
  y: number;
  cx: number;
  cy: number;
  angleDeg: number;
} {
  const pct = Math.max(0, Math.min(100, barPct));
  const angleRad = Math.PI * (1 - pct / 100);
  const cx = 100;
  const cy = 108;
  const r = 70;
  return {
    cx,
    cy,
    x: cx + r * Math.cos(angleRad),
    y: cy - r * Math.sin(angleRad),
    angleDeg: (angleRad * 180) / Math.PI,
  };
}

/** Tooltip corto para el gauge (sin essays). */
export function riskGaugeHint(card: InvestorRiskCard): string {
  const parts: string[] = [];
  if (card.heatLabel && card.heat !== 'none') parts.push(card.heatLabel);
  if (card.riskRaw) parts.push(`Riesgo ${card.riskRaw}`);
  if (card.rewardMultiple != null) {
    parts.push(`R:R 1:${card.rewardMultiple.toFixed(1)}`);
  } else if (card.rrRaw) {
    parts.push(`R:R ${card.rrRaw}`);
  }
  return parts.join(' · ') || 'Sin dato';
}

/**
 * Tarjeta de riesgo para Modo Inversor / Vista rápida.
 * La barra de calor mide comodidad del plan (R:R o distancia vs precio), no el $ de la cuenta.
 */
export function investorRiskCard(s: SignalSummary | null): InvestorRiskCard {
  const empty: InvestorRiskCard = {
    active: false,
    heat: 'none',
    barPct: 0,
    heatLabel: 'Sin dato',
    riskRaw: null,
    riskNumber: null,
    rrRaw: null,
    rewardMultiple: null,
    vsPricePct: null,
    title: 'Sin riesgo activo',
    lead: 'Todavía no hay datos de riesgo en este reporte.',
    bullets: [],
    tip: null,
  };
  if (!s) return empty;

  const v = (s.verdict || '').toUpperCase();
  const noOperar = /NO_OPERAR|NO OPERAR/.test(v);
  const riskRaw = s.planDetails?.risk?.trim() || null;
  const riskNumber = parseFirstNumber(riskRaw);
  const rrRaw = s.planDetails?.rr?.trim() || null;
  const rewardMultiple = parseRewardMultiple(rrRaw);
  const entry = parseFirstNumber(s.planDetails?.entry || s.entryOptima || s.price);
  const hasPlan = hasPlanMatrix(s) || !!(s.plan && String(s.plan).trim());

  if (noOperar || (!hasPlan && !riskRaw)) {
    if (noOperar) {
      return {
        ...empty,
        active: true,
        heat: 'cool',
        barPct: 8,
        heatLabel: 'Fresco',
        title: 'Sin riesgo activo',
        lead: 'Sin riesgo',
        bullets: [],
        tip: null,
      };
    }
    return {
      ...empty,
      active: true,
      title: 'Riesgo no definido',
      lead: 'Sin dato',
      bullets: [],
      tip: null,
    };
  }

  let vsPricePct: number | null = null;
  if (riskNumber != null && entry != null && entry !== 0) {
    vsPricePct = Math.abs((riskNumber / entry) * 100);
  }

  let heat: RiskHeat = 'warm';
  let barPct = 50;
  let heatLabel = 'Templado';
  if (rewardMultiple != null) {
    const h = heatFromRewardMultiple(rewardMultiple);
    heat = h.heat;
    barPct = h.barPct;
    heatLabel = h.label;
  } else if (vsPricePct != null) {
    const h = heatFromPricePct(vsPricePct);
    heat = h.heat;
    barPct = h.barPct;
    heatLabel = h.label;
  } else if (riskNumber != null) {
    barPct = 55;
  }

  const title = riskRaw ? `Riesgo ${riskRaw}` : 'Riesgo del plan';
  const lead = heatLabel;
  const bullets: string[] = [];
  if (riskRaw) bullets.push(riskRaw);
  if (rewardMultiple != null) bullets.push(`1:${rewardMultiple.toFixed(1)}`);

  return {
    active: true,
    heat,
    barPct,
    heatLabel,
    riskRaw,
    riskNumber,
    rrRaw,
    rewardMultiple,
    vsPricePct,
    title,
    lead,
    bullets,
    tip: null,
  };
}

/** @deprecated Preferir investorRiskCard; se mantiene por compatibilidad. */
export function investorRiskParagraphs(s: SignalSummary | null): string[] {
  const card = investorRiskCard(s);
  if (!card.active) return [card.lead];
  return [card.lead, ...card.bullets, ...(card.tip ? [card.tip] : [])];
}

export function investorScoreRows(s: SignalSummary | null): InvestorExplainRow[] {
  if (!s) return [];
  const rows: InvestorExplainRow[] = [];
  if (s.rulesPct != null) {
    rows.push({
      campo: 'Reglas',
      valor: `${s.rulesPct}%`,
      significado: 'Qué tan bien cumple esta idea las reglas del sistema (más alto = más alineada).',
    });
  }
  if (s.mlPct != null) {
    rows.push({
      campo: 'Modelo automático',
      valor: `${s.mlPct}%`,
      significado: 'Qué tan fuerte ve la idea el modelo de machine learning.',
    });
  }
  if (s.confluencePct != null || s.confluenceLabel) {
    const parts: string[] = [];
    if (s.confluenceLabel) parts.push(s.confluenceLabel);
    if (s.confluencePct != null) parts.push(`${s.confluencePct}%`);
    rows.push({
      campo: 'Acuerdo',
      valor: parts.join(' · ') || '—',
      significado: 'Cuántas capas van a favor a la vez. Más alto = más consenso.',
    });
  }
  if (s.scoreCombined != null) {
    rows.push({
      campo: 'Probabilidad de éxito',
      valor: `${s.scoreCombined}%`,
      significado: 'Resumen de 0 a 100 de la fuerza de la idea (score combinado).',
    });
  }
  if (s.scoreExtended != null) {
    rows.push({
      campo: 'Nota ampliada',
      valor: `${s.scoreExtended}%`,
      significado: 'Misma escala 0–100, pero con más capas del análisis.',
    });
  }
  return rows;
}

export function investorScoresWaitTip(s: SignalSummary | null): string | null {
  if (!s) return null;
  const label = (s.confluenceLabel || '').toUpperCase();
  const baja =
    /BAJA|LOW|DÉBIL|DEBIL/.test(label) ||
    (s.confluencePct != null && s.confluencePct < 50);
  const scoreBajo = s.scoreCombined != null && s.scoreCombined < 50;
  if (baja || scoreBajo) {
    return 'Tip: la nota o el acuerdo entre capas es bajo. Mejor esperar otra oportunidad más clara.';
  }
  return null;
}

export function investorPlanRows(s: SignalSummary | null): KpiRow[] {
  const pd = s?.planDetails;
  if (!pd) {
    if (s?.plan) return [{ campo: 'Tipo de plan', valor: s.plan }];
    return [];
  }
  const rows: KpiRow[] = [];
  if (pd.entry) rows.push({ campo: 'Dónde entrar', valor: pd.entry });
  if (pd.sl) rows.push({ campo: 'Stop (dónde salir si falla)', valor: pd.sl });
  if (pd.tp) rows.push({ campo: 'Objetivo (dónde tomar ganancia)', valor: pd.tp });
  if (pd.rr) rows.push({ campo: 'Relación riesgo / beneficio', valor: pd.rr });
  return rows;
}

export function volAxisMax(s: SignalSummary | null): number {
  const ext = s?.volume?.thresholds?.extreme;
  const ratio = s?.volume?.ratio;
  const base = Math.max(ext || 2.6, ratio || 0, 1);
  return base * 1.15;
}

export function volMarkerPct(
  value: number | null | undefined,
  s: SignalSummary | null
): number {
  if (value == null) return 0;
  const max = volAxisMax(s);
  return Math.max(0, Math.min(100, (value / max) * 100));
}

/** Celdas Entrada / Stop / Objetivo / R:B / Riesgo con la ejecución real de MT5. */
export interface ExecutionLevels {
  entry: string;
  sl: string;
  exit: string;
  /** R realizado con signo: (salida − entrada) / |entrada − SL|, a favor de la posición. */
  realizedR: string;
  risk: string;
  /** El SL con que se abrió en MT5 difiere del plan. */
  slChanged: boolean;
  ticket: number;
}

const planNum = (v: string | null | undefined): number => Number(String(v ?? '').replace(',', '.'));
const planDecimals = (vals: (string | null | undefined)[]): number =>
  Math.min(5, Math.max(0, ...vals.map((v) => (String(v ?? '').split('.')[1] || '').length)));

/**
 * Niveles realmente ejecutados (entrada, salida, SL, R realizado) sin tocar el plan; null si no hay
 * ejecución MT5 completa o el plan no tiene niveles. Riesgo solo cambia si el SL real difiere.
 */
export function executionLevels(
  pd: PlanDetails | null | undefined,
  real: HistoryMt5Real | null | undefined
): ExecutionLevels | null {
  if (!pd || !real?.entry || !real.exit) return null;
  const [entry, sl] = [planNum(pd.entry), planNum(pd.sl)];
  if (!(entry > 0) || !(sl > 0)) return null;
  const dec = planDecimals([pd.entry, pd.sl, pd.tp]);
  const fmt = (n: number) => n.toFixed(dec);
  const long = sl < entry;
  const slReal = real.sl && real.sl > 0 ? real.sl : sl;
  const slChanged = Math.abs(slReal - sl) >= 10 ** -dec / 2;
  const risk = Math.abs(real.entry - slReal);
  const move = (real.exit - real.entry) * (long ? 1 : -1);
  let realizedR = 'n/d';
  if (risk > 0) {
    const r = move / risk;
    realizedR = `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(2)}R`;
  }
  return {
    entry: fmt(real.entry),
    sl: fmt(slReal),
    exit: fmt(real.exit),
    realizedR,
    risk: slChanged ? fmt(risk) : pd.risk || fmt(risk),
    slChanged,
    ticket: real.ticket,
  };
}
