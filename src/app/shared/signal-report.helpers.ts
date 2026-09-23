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

export function verdictRows(s: SignalSummary | null): KpiRow[] {
  if (!s?.verdict) return [];
  return [{ campo: 'Veredicto', valor: s.verdict }];
}

export function marketRows(s: SignalSummary | null): KpiRow[] {
  if (!s) return [];
  const rows: KpiRow[] = [];
  if (s.price) rows.push({ campo: 'Precio', valor: s.price });
  if (s.entryOptima) rows.push({ campo: 'Entrada óptima', valor: s.entryOptima });
  if (s.plan) rows.push({ campo: 'Plan', valor: s.plan });
  return rows;
}

export function setupRows(s: SignalSummary | null): KpiRow[] {
  if (!s) return [];
  const rows: KpiRow[] = [];
  if (s.bias) rows.push({ campo: 'Bias', valor: s.bias });
  if (s.twoM5) rows.push({ campo: '2M5', valor: s.twoM5 });
  if (s.setup) rows.push({ campo: 'Setup', valor: s.setup });
  if (s.winrate) rows.push({ campo: 'Winrate', valor: s.winrate });
  if (s.impulso) rows.push({ campo: 'Impulso', valor: s.impulso });
  return rows;
}

export function scoreKpiRows(s: SignalSummary | null): KpiRow[] {
  if (!s) return [];
  const rows: KpiRow[] = [];
  if (s.rulesPct != null) rows.push({ campo: 'Rules', valor: `${s.rulesPct}%` });
  if (s.mlPct != null) rows.push({ campo: 'ML', valor: `${s.mlPct}%` });
  if (s.confluencePct != null) {
    const label = s.confluenceLabel ? `${s.confluenceLabel} · ` : '';
    rows.push({ campo: 'Confluencia', valor: `${label}${s.confluencePct}%` });
  }
  if (s.scoreCombined != null) {
    rows.push({ campo: 'Score combinado', valor: `${s.scoreCombined}%` });
  }
  if (s.scoreExtended != null) {
    rows.push({ campo: 'Score extendido', valor: `${s.scoreExtended}%` });
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
  if (/NO_OPERAR|NO OPERAR|ESPERAR|WAIT/.test(t)) return 'warn';
  if (/OPERAR|LONG|SHORT|GO/.test(t) && !/NO_/.test(t)) return 'ok';
  return '';
}

export function investorVerdictTitle(s: SignalSummary | null): string {
  const v = (s?.verdict || '').toUpperCase();
  if (/NO_OPERAR|NO OPERAR/.test(v)) return 'No operar ahora';
  if (/ESPERAR|WAIT/.test(v)) return 'Esperar';
  if (/OPERAR|LONG|SHORT|GO/.test(v) && !/NO_/.test(v)) return 'Hay señal de entrada';
  return s?.verdict || 'Sin veredicto aún';
}

export function investorVerdictExplain(s: SignalSummary | null): string {
  const v = (s?.verdict || '').toUpperCase();
  if (/NO_OPERAR|NO OPERAR/.test(v)) {
    return 'El sistema recomienda no abrir una operación en este momento. Las condiciones no son favorables.';
  }
  if (/ESPERAR|WAIT/.test(v)) {
    return 'Conviene esperar: aún faltan confirmaciones. No entres solo por impulso.';
  }
  if (/OPERAR|LONG|SHORT|GO/.test(v) && !/NO_/.test(v)) {
    return 'El sistema ve una oportunidad. Si decides operar, sigue el plan de entrada, stop y objetivo.';
  }
  return 'Cuando ejecutes una señal, aquí verás en lenguaje simple qué conviene hacer.';
}

export function investorActionHint(s: SignalSummary | null): string {
  const v = (s?.verdict || '').toUpperCase();
  if (/NO_OPERAR|NO OPERAR|ESPERAR|WAIT/.test(v)) {
    return 'Acción sugerida: no entrar. Espera una nueva señal más clara.';
  }
  if (/OPERAR|LONG|SHORT|GO/.test(v) && !/NO_/.test(v)) {
    return 'Acción sugerida: solo si aceptas el riesgo del plan (entrada, stop y objetivo).';
  }
  return 'Ejecuta una señal o recarga el último reporte para ver la recomendación.';
}

export function investorRiskParagraphs(s: SignalSummary | null): string[] {
  if (!s) return ['Aún no hay datos de riesgo.'];

  const v = (s.verdict || '').toUpperCase();
  const noOperar = /NO_OPERAR|NO OPERAR/.test(v);
  const risk = s.planDetails?.risk?.trim() || null;
  const hasPlan = hasPlanMatrix(s) || !!(s.plan && String(s.plan).trim());

  if (noOperar || (!hasPlan && !risk)) {
    if (noOperar) {
      return [
        'No hay riesgo activo porque el sistema recomienda no operar. En esta idea no hay una operación que debas asumir.',
      ];
    }
    return [
      'No hay un plan de entrada con stop en este reporte, así que no hay un riesgo de operación definido.',
    ];
  }

  if (risk) {
    return [
      `Riesgo del plan: ${risk}. Es la distancia (puntos o $ del reporte) entre la entrada y el stop: lo máximo que podrías perder en esta idea si el precio toca el stop.`,
      'No es una garantía de resultado ni el tamaño de tu cuenta: solo el riesgo de esta operación según el plan.',
      'Si no estás cómodo perdiendo esa cantidad, no entres.',
    ];
  }

  const entry = s.planDetails?.entry?.trim();
  const sl = s.planDetails?.sl?.trim();
  if (entry && sl) {
    return [
      `El plan marca entrada en ${entry} y stop (protección) en ${sl}. El riesgo es lo que podrías perder si el precio llega al stop desde la entrada.`,
      'Si no estás cómodo con esa pérdida posible, no entres.',
    ];
  }

  return [
    'Hay un plan, pero el reporte no trae el número de riesgo. Opera solo con un tamaño que puedas asumir si el stop se activa.',
  ];
}

export function investorScoreRows(s: SignalSummary | null): InvestorExplainRow[] {
  if (!s) return [];
  const rows: InvestorExplainRow[] = [];
  if (s.rulesPct != null) {
    rows.push({
      campo: 'Rules',
      valor: `${s.rulesPct}%`,
      significado: 'Qué tan alineadas están las reglas del plan con esta idea.',
    });
  }
  if (s.mlPct != null) {
    rows.push({
      campo: 'ML',
      valor: `${s.mlPct}%`,
      significado: 'Qué tan fuerte ve la señal el modelo automático.',
    });
  }
  if (s.confluencePct != null || s.confluenceLabel) {
    const parts: string[] = [];
    if (s.confluenceLabel) parts.push(s.confluenceLabel);
    if (s.confluencePct != null) parts.push(`${s.confluencePct}%`);
    rows.push({
      campo: 'Confluencia',
      valor: parts.join(' · ') || '—',
      significado: 'Cuántos factores van a favor a la vez (más alto = más acuerdo).',
    });
  }
  if (s.scoreCombined != null) {
    rows.push({
      campo: 'Score combinado',
      valor: `${s.scoreCombined}%`,
      significado: 'Nota global de la idea, de 0 a 100.',
    });
  }
  if (s.scoreExtended != null) {
    rows.push({
      campo: 'Score extendido',
      valor: `${s.scoreExtended}%`,
      significado: 'Nota ampliada con más capas del sistema (también 0–100).',
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
    return 'Tip: la nota o la confluencia es baja. Mejor esperar otra oportunidad más clara.';
  }
  return null;
}

export function investorPlanRows(s: SignalSummary | null): KpiRow[] {
  const pd = s?.planDetails;
  if (!pd) {
    if (s?.plan) return [{ campo: 'Plan', valor: s.plan }];
    return [];
  }
  const rows: KpiRow[] = [];
  if (pd.entry) rows.push({ campo: 'Entrada', valor: pd.entry });
  if (pd.sl) rows.push({ campo: 'Stop (protección)', valor: pd.sl });
  if (pd.tp) rows.push({ campo: 'Objetivo', valor: pd.tp });
  if (pd.rr) rows.push({ campo: 'Relación riesgo/beneficio', valor: pd.rr });
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
