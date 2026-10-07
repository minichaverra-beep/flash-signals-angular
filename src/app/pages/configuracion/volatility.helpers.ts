/**
 * Utilidades de presentación de la sección Volatilidad (/configuracion).
 * La lógica de negocio (cálculo de SL/TP, lotes, ATR) vive en server/volatility.js; aquí solo se
 * clasifica el VIX con los umbrales del borrador (aún sin guardar) y se preparan textos y barras.
 */
import type { VolatilityLevel, VolatilityMood } from '../../services/signals-api.service';

export interface VixThresholds {
  vixLowMax: number;
  vixNormalMax: number;
  vixHighMax: number;
}

export interface VixMultipliers {
  vixMultLow: number;
  vixMultNormal: number;
  vixMultHigh: number;
  vixMultExtreme: number;
}

export const LEVEL_IDS: VolatilityLevel[] = ['baja', 'normal', 'alta', 'extrema'];
export const LEVEL_LABELS: Record<VolatilityLevel, string> = {
  baja: 'Baja',
  normal: 'Normal',
  alta: 'Alta',
  extrema: 'Extrema',
};

export const MOOD_IDS: VolatilityMood[] = ['tranquilo', 'normal', 'movido', 'muy_movido'];
export const MOOD_LABELS: Record<VolatilityMood, string> = {
  tranquilo: 'Tranquilo',
  normal: 'Normal',
  movido: 'Movido',
  muy_movido: 'Muy movido',
};
export const MOOD_BY_LEVEL: Record<VolatilityLevel, VolatilityMood> = {
  baja: 'tranquilo',
  normal: 'normal',
  alta: 'movido',
  extrema: 'muy_movido',
};
export const LEVEL_BY_MOOD: Record<VolatilityMood, VolatilityLevel> = {
  tranquilo: 'baja',
  normal: 'normal',
  movido: 'alta',
  muy_movido: 'extrema',
};

/** Baja < low · Normal [low, normal) · Alta [normal, high] · Extrema > high (misma regla que el servidor). */
export function classifyVix(points: number | null | undefined, t: VixThresholds): VolatilityLevel | null {
  const p = Number(points);
  if (points == null || !Number.isFinite(p) || p <= 0) return null;
  if (p < t.vixLowMax) return 'baja';
  if (p < t.vixNormalMax) return 'normal';
  if (p <= t.vixHighMax) return 'alta';
  return 'extrema';
}

export function levelMultiplier(level: VolatilityLevel | null, m: VixMultipliers): number {
  const value = { baja: m.vixMultLow, normal: m.vixMultNormal, alta: m.vixMultHigh, extrema: m.vixMultExtreme }[level ?? 'normal'];
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function levelRangeText(level: VolatilityLevel, t: VixThresholds): string {
  switch (level) {
    case 'baja':
      return `Menos de ${t.vixLowMax}`;
    case 'normal':
      return `${t.vixLowMax} a ${t.vixNormalMax}`;
    case 'alta':
      return `${t.vixNormalMax} a ${t.vixHighMax}`;
    default:
      return `Más de ${t.vixHighMax}`;
  }
}

/** Termómetro: ancho de cada zona y posición del marcador (0–100 %) en una escala 0 … 1,5 × umbral alto. */
export function thermometer(
  points: number | null | undefined,
  t: VixThresholds
): { zones: { level: VolatilityLevel; widthPct: number }[]; markerPct: number } {
  const p = Number(points);
  const max = Math.max(t.vixHighMax * 1.5, Number.isFinite(p) ? p : 0);
  const edges = [0, t.vixLowMax, t.vixNormalMax, t.vixHighMax, max];
  const zones = LEVEL_IDS.map((level, i) => ({ level, widthPct: ((edges[i + 1] - edges[i]) / max) * 100 }));
  const markerPct = Number.isFinite(p) && p > 0 ? Math.min(100, (p / max) * 100) : 0;
  return { zones, markerPct };
}

/** Reparto de la barra riesgo/beneficio: cada lado en % del total (mínimo visible 4 %). */
export function riskRewardBar(risk: number, reward: number): { riskPct: number; rewardPct: number } {
  const total = risk + reward;
  if (!(total > 0)) return { riskPct: 50, rewardPct: 50 };
  const riskPct = Math.min(96, Math.max(4, (risk / total) * 100));
  return { riskPct, rewardPct: 100 - riskPct };
}

export function formatNumber(n: number, maxDecimals = 2, minDecimals = 0): string {
  return n.toLocaleString('es-ES', { minimumFractionDigits: minDecimals, maximumFractionDigits: maxDecimals });
}

export function formatMoney(n: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : currency;
  return `${formatNumber(n, 2, Number.isInteger(n) ? 0 : 2)} ${symbol}`;
}

/** «hace 3 min» / «hace 2 h» / «hace 1 d» respecto a `now` (ms). */
export function ageText(iso: string | null | undefined, now = Date.now()): string {
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'hace unos segundos';
  if (min < 60) return `hace ${min} min`;
  if (min < 24 * 60) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} d`;
}
