/**
 * Métricas del historial a partir de la lista cargada (filtro de mercado).
 * Prefiere PnL real en $ (pnlUsd) cuando todas las cerradas lo tienen;
 * si no, estima en R con R:R planificado. No inventa valores faltantes.
 */

export type HistoryResultadoLite = 'ganada' | 'perdida' | 'no_tomada';

export type HistoryPnlUnit = 'usd' | 'R';

export interface HistoryMetricSource {
  id: number;
  createdAt: string;
  resultado?: HistoryResultadoLite | null;
  /** R:R del plan (summary.planDetails.rr), si el listado lo expone. */
  plannedRr?: string | null;
  /** PnL real en USD (nullable; editable en /historial). */
  pnlUsd?: number | null;
}

export interface HistoryMetrics {
  total: number;
  closed: number;
  wins: number;
  losses: number;
  unmarked: number;
  /** Tasa de acierto % sobre cerradas con resultado. */
  winratePct: number | null;
  /** Máx. pérdidas consecutivas (orden cronológico). */
  maxConsecutiveLosses: number | null;
  /** Media del múltiplo de recompensa planificado (solo filas con R:R parseable). */
  avgRewardMultiple: number | null;
  avgRrSample: number;
  /**
   * PnL agregado (unidad según pnlUnit).
   * null si no hay serie usable ($ incompleto y R incompleto).
   */
  pnl: number | null;
  /** 'usd' si todas las cerradas tienen pnlUsd; 'R' si estimación; null si n/d. */
  pnlUnit: HistoryPnlUnit | null;
  /** Alias de pnl cuando pnlUnit === 'R' (compat UI/tests). */
  pnlR: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  /** Alias de expectancy cuando pnlUnit === 'R'. */
  expectancyR: number | null;
  maxDrawdown: number | null;
  /** Alias de maxDrawdown cuando pnlUnit === 'R'. */
  maxDrawdownR: number | null;
  /** Curva de equity (cronológica) para sparkline; vacía si pnl es null. */
  equityCurve: number[];
  /** Alias de equityCurve (nombre histórico). */
  equityCurveR: number[];
  /** Notas en español sobre qué falta para completar métricas. */
  notes: string[];
}

/** Igual que parseRewardMultiple del reporte — copia local para tests Node sin resolver .ts. */
function parseRewardMultiple(rr: string | null | undefined): number | null {
  if (!rr) return null;
  const t = String(rr).trim().toLowerCase().replace(',', '.');
  const ratioRe = /(\d{1,12}(?:\.\d{1,12})?)[:/a](\d{1,12}(?:\.\d{1,12})?)/i;
  const ratio = ratioRe.exec(t);
  if (ratio) {
    const a = Number(ratio[1]);
    const b = Number(ratio[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
    return b >= a ? b / a : a / b;
  }
  const singleRe = /(\d{1,12}(?:\.\d{1,12})?)/;
  const single = singleRe.exec(t);
  if (!single) return null;
  const n = Number(single[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function chronological(items: HistoryMetricSource[]): HistoryMetricSource[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    if (ta !== tb) return ta - tb;
    return a.id - b.id;
  });
}

/** Cerrada para métricas: solo ganada/perdida. no_tomada y vacío excluidos. */
function isClosed(
  r: HistoryResultadoLite | null | undefined
): r is 'ganada' | 'perdida' {
  return r === 'ganada' || r === 'perdida';
}

function hasPnlUsd(item: HistoryMetricSource): boolean {
  return item.pnlUsd != null && Number.isFinite(Number(item.pnlUsd));
}

/** PnL en R de una fila cerrada; null si ganada sin R:R usable. */
function tradeR(item: HistoryMetricSource): number | null {
  if (item.resultado === 'perdida') return -1;
  if (item.resultado === 'ganada') {
    const m = parseRewardMultiple(item.plannedRr);
    return m != null && m > 0 ? m : null;
  }
  return null;
}

function finishSeries(
  series: number[],
  unit: HistoryPnlUnit,
  notes: string[]
): Pick<
  HistoryMetrics,
  | 'pnl'
  | 'pnlUnit'
  | 'pnlR'
  | 'profitFactor'
  | 'expectancy'
  | 'expectancyR'
  | 'maxDrawdown'
  | 'maxDrawdownR'
  | 'equityCurve'
  | 'equityCurveR'
> {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let grossWin = 0;
  let grossLoss = 0;
  const equityCurve: number[] = [];
  for (const r of series) {
    equity += r;
    equityCurve.push(Math.round(equity * 100) / 100);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (r > 0) grossWin += r;
    else if (r < 0) grossLoss += Math.abs(r);
  }
  const pnl = Math.round(equity * 100) / 100;
  const maxDrawdown = Math.round(maxDd * 100) / 100;
  const expectancy = Math.round((equity / series.length) * 1000) / 1000;
  let profitFactor: number | null = null;
  if (grossLoss > 0) {
    profitFactor = Math.round((grossWin / grossLoss) * 100) / 100;
  } else if (grossWin > 0) {
    notes.push(
      unit === 'usd'
        ? 'Profit factor: n/d — no hay pérdidas en $ en la muestra (división por cero).'
        : 'Profit factor: n/d — no hay pérdidas en R en la muestra (división por cero).'
    );
  }
  if (unit === 'usd') {
    notes.push('PnL, PF, expectativa y drawdown en $ reales (pnlUsd por operación).');
  } else {
    notes.push(
      'PnL y drawdown en unidades R (no $). Rellena «$/PnL» en cada operación cerrada para métricas en dinero.'
    );
  }
  return {
    pnl,
    pnlUnit: unit,
    pnlR: unit === 'R' ? pnl : null,
    profitFactor,
    expectancy,
    expectancyR: unit === 'R' ? expectancy : null,
    maxDrawdown,
    maxDrawdownR: unit === 'R' ? maxDrawdown : null,
    equityCurve,
    equityCurveR: equityCurve,
  };
}

export function computeHistoryMetrics(
  items: HistoryMetricSource[]
): HistoryMetrics {
  const total = items.length;
  const wins = items.filter((i) => i.resultado === 'ganada').length;
  const losses = items.filter((i) => i.resultado === 'perdida').length;
  const closed = wins + losses;
  const unmarked = total - closed;
  const notes: string[] = [];

  const winratePct =
    closed > 0 ? Math.round((wins / closed) * 1000) / 10 : null;

  const ordered = chronological(items);
  let maxConsecutiveLosses: number | null = null;
  if (closed > 0) {
    let streak = 0;
    let maxStreak = 0;
    for (const it of ordered) {
      if (it.resultado === 'perdida') {
        streak += 1;
        if (streak > maxStreak) maxStreak = streak;
      } else if (it.resultado === 'ganada') {
        streak = 0;
      }
    }
    maxConsecutiveLosses = maxStreak;
  }

  const rrValues: number[] = [];
  for (const it of items) {
    const m = parseRewardMultiple(it.plannedRr);
    if (m != null && m > 0) rrValues.push(m);
  }
  const avgRrSample = rrValues.length;
  const avgRewardMultiple =
    avgRrSample > 0
      ? Math.round(
          (rrValues.reduce((s, v) => s + v, 0) / avgRrSample) * 100
        ) / 100
      : null;

  if (avgRewardMultiple == null) {
    notes.push(
      'R:R planificado: n/d — el listado no trae planDetails.rr o no es parseable.'
    );
  }

  const closedOrdered = ordered.filter((i) => isClosed(i.resultado));
  let seriesResult: ReturnType<typeof finishSeries> | null = null;

  if (closedOrdered.length === 0) {
    notes.push(
      'PnL, profit factor, expectativa y drawdown: n/d — marca ganada/perdida en el historial.',
      'Opcional: rellena $/PnL por operación para métricas en dinero; si no, con R:R se estima en R (pérdida = −1R).'
    );
  } else {
    const allHaveUsd = closedOrdered.every(hasPnlUsd);
    if (allHaveUsd) {
      const usdSeries = closedOrdered.map((it) => Number(it.pnlUsd));
      seriesResult = finishSeries(usdSeries, 'usd', notes);
    } else {
      const withUsd = closedOrdered.filter(hasPnlUsd).length;
      if (withUsd > 0 && withUsd < closedOrdered.length) {
        notes.push(
          `PnL en $ incompleto (${withUsd}/${closedOrdered.length} cerradas con $/PnL) — no se mezclan $ y R; se intenta estimación en R.`
        );
      }

      const rSeries: number[] = [];
      let missingRrWins = 0;
      for (const it of closedOrdered) {
        const r = tradeR(it);
        if (r == null) {
          missingRrWins += 1;
          break;
        }
        rSeries.push(r);
      }

      if (missingRrWins > 0 || rSeries.length !== closedOrdered.length) {
        notes.push(
          'PnL / PF / expectativa / max drawdown: n/d — falta $/PnL en todas las cerradas o R:R planificado en todas las ganadas (pérdida = −1R).'
        );
      } else {
        seriesResult = finishSeries(rSeries, 'R', notes);
      }
    }
  }

  if (closed === 0 && total > 0) {
    notes.unshift(
      'Tasa de acierto y rachas: n/d hasta marcar resultado (ganada/perdida).'
    );
  }

  const emptySeries = {
    pnl: null as number | null,
    pnlUnit: null as HistoryPnlUnit | null,
    pnlR: null as number | null,
    profitFactor: null as number | null,
    expectancy: null as number | null,
    expectancyR: null as number | null,
    maxDrawdown: null as number | null,
    maxDrawdownR: null as number | null,
    equityCurve: [] as number[],
    equityCurveR: [] as number[],
  };

  const s = seriesResult ?? emptySeries;

  return {
    total,
    closed,
    wins,
    losses,
    unmarked,
    winratePct,
    maxConsecutiveLosses,
    avgRewardMultiple,
    avgRrSample,
    ...s,
    notes,
  };
}

/** Formato UI: número o «n/d». */
export function formatMetric(
  value: number | null | undefined,
  opts: { suffix?: string; digits?: number } = {}
): string {
  if (value == null || !Number.isFinite(value)) return 'n/d';
  const digits = opts.digits ?? 2;
  const shown =
    digits === 0
      ? String(Math.round(value))
      : (Math.round(value * 10 ** digits) / 10 ** digits).toFixed(digits);
  return `${shown}${opts.suffix ?? ''}`;
}

/** Formato currency-ish para celda $/PnL (sin inventar si vacío). */
export function formatPnlMoneyInput(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '';
  return (Math.round(value * 100) / 100).toFixed(2);
}
