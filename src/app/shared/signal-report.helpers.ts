import type {
  ChecklistItem,
  SignalSummary,
} from '../services/signals-api.service';

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
  return !!(s?.checklist2M5?.length || s?.checklistE1?.length);
}

export function hasDetalleAdicional(
  s: SignalSummary | null,
  preview?: string | null
): boolean {
  return !!(s?.volume || s?.redFlags?.length || preview);
}

export function verdictTone(v: string | null | undefined): string {
  const t = (v || '').toUpperCase();
  // Porcentaje (Probabilidad de éxito) — no es un badge wait/stop
  const pct = String(v || '').match(/^\s*(\d+(?:[.,]\d+)?)\s*%\s*$/);
  if (pct) {
    return successProbabilityTone(Number(String(pct[1]).replace(',', '.')));
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
  const m = String(winrate || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return '';
  return successProbabilityTone(Number(String(m[1]).replace(',', '.')));
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
  const m = String(raw).replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Interpreta R:R tipo "1:2.5", "2.5", "1 a 3". Devuelve múltiplo de recompensa. */
export function parseRewardMultiple(rr: string | null | undefined): number | null {
  if (!rr) return null;
  const t = String(rr).trim().toLowerCase().replace(',', '.');
  const ratio = t.match(/(\d+(?:\.\d+)?)\s*[:/a]\s*(\d+(?:\.\d+)?)/i);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
    // "1:2" = arriesgo 1 para ganar 2 → múltiplo 2
    // Si viene "2:1" raro, tomamos max/min para no invertir mal si a>b
    return b >= a ? b / a : a / b;
  }
  const single = t.match(/(\d+(?:\.\d+)?)/);
  if (!single) return null;
  const n = Number(single[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
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
    heat = 'warm';
    barPct = 55;
    heatLabel = 'Templado';
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

export type { ChecklistItem };
