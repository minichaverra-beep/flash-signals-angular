/**
 * Exportación del historial (Excel / PDF): tablas y analítica derivada.
 * Helpers puros (sin Angular ni librerías) para poder testearlos con node --test.
 * Los writers (exceljs / jspdf) viven en historial-export.writers.ts y se cargan bajo demanda.
 */

export type ExportMode = 'resumido' | 'detallado';

export type CellKind = 'text' | 'int' | 'number' | 'ratio' | 'money' | 'percent' | 'datetime';

export type CellValue = string | number | null;

/** Pista de color para el writer (resultado / beneficio / tipo buy-sell). */
export type CellTone = 'result' | 'profit' | 'type';

export interface ExportColumn {
  key: string;
  header: string;
  /** Ancho aproximado en caracteres (Excel) — el PDF lo usa como peso relativo. */
  width: number;
  kind: CellKind;
  tone?: CellTone;
}

export interface ExportTable {
  title: string;
  columns: ExportColumn[];
  rows: Record<string, CellValue>[];
}

export type ExportResultado = 'ganada' | 'perdida' | 'no_tomada';

export interface ExportItem {
  id: number;
  createdAt: string;
  market: string;
  tier?: string | null;
  status?: string | null;
  bias?: string | null;
  winrate?: string | null;
  scoreCombined?: number | null;
  plannedRr?: string | null;
  plannedEntry?: number | null;
  plannedSl?: number | null;
  plannedTp?: number | null;
  entry?: string | null;
  comment?: string | null;
  motivoEntradaSalida?: string | null;
  resultado?: ExportResultado | null;
  pnlUsd?: number | null;
  tags?: Array<{ name?: string | null }> | null;
  confluencias?: Array<{ name?: string | null }> | null;
}

/** Callbacks de presentación que ya existen en la app (bias, buy/sell, tasa). */
export interface ExportRowHelpers {
  tradeType(item: ExportItem): 'buy' | 'sell' | null;
  biasText(item: ExportItem): string;
  hitRate(item: ExportItem): string;
}

/** Subconjunto de HistoryMetrics que consume la exportación. */
export interface ExportMetricsLite {
  total: number;
  closed: number;
  wins: number;
  losses: number;
  unmarked: number;
  winratePct: number | null;
  maxConsecutiveLosses: number | null;
  avgRewardMultiple: number | null;
  pnl: number | null;
  pnlUnit: 'usd' | 'R' | null;
  profitFactor: number | null;
  expectancy: number | null;
  maxDrawdown: number | null;
  equityCurve: number[];
  notes: string[];
}

export interface ExportTotals {
  ganadas: number;
  perdidas: number;
  noTomadas: number;
  pendientes: number;
  /** Suma de pnlUsd (sin no tomadas); null si ninguna fila tiene $/PnL. */
  profit: number | null;
}

export interface TradeRef {
  id: number;
  market: string;
  createdAt: string;
  pnl: number;
}

export interface ExtraKpis {
  bestTrade: TradeRef | null;
  worstTrade: TradeRef | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Ganancia media / pérdida media (en $). */
  payoff: number | null;
  maxWinStreak: number | null;
  /** % de filas marcadas como no tomadas sobre el total. */
  noTomadaPct: number | null;
  /** % de filas con resultado marcado (disciplina de registro). */
  markedPct: number | null;
  /** Cerradas (ganada/perdida) con $/PnL informado. */
  closedWithPnl: number;
}

export type KpiTone = 'ok' | 'bad' | 'warn' | 'neutral';

export interface KpiEntry {
  label: string;
  value: string;
  hint: string;
  tone: KpiTone;
}

export interface GroupStat {
  label: string;
  trades: number;
  ganadas: number;
  perdidas: number;
  noTomadas: number;
  pendientes: number;
  winratePct: number | null;
  pnl: number | null;
  avgPnl: number | null;
  profitFactor: number | null;
}

export interface ExportBundle {
  mode: ExportMode;
  marketLabel: string;
  /** Alcance legible, p. ej. «Página 2 de 5 · 15 por página» o «Todas las páginas». */
  scopeLabel: string;
  /** Sufijo del nombre de archivo según alcance (p. ej. «p2»); vacío = todas. */
  fileTag: string;
  generatedAt: Date;
  table: ExportTable;
  totals: ExportTotals;
  kpis: KpiEntry[];
  breakdowns: ExportTable[];
  equity: ExportTable | null;
  equityCurve: number[];
  pnlUnit: 'usd' | 'R' | null;
  notes: string[];
}

const DASH = '—';

const RESULT_LABEL: Record<ExportResultado, string> = {
  ganada: 'Ganada',
  perdida: 'Perdida',
  no_tomada: 'No tomada',
};

export function resultLabel(r: ExportResultado | null | undefined): string {
  return r ? RESULT_LABEL[r] : 'Pendiente';
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

function isClosed(r: ExportResultado | null | undefined): r is 'ganada' | 'perdida' {
  return r === 'ganada' || r === 'perdida';
}

function chronological<T extends { id: number; createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return ta !== tb ? ta - tb : a.id - b.id;
  });
}

function entryPrice(item: ExportItem): number | null {
  if (finite(item.plannedEntry)) return item.plannedEntry;
  const n = Number(String(item.entry ?? '').replace(',', '.'));
  return item.entry && Number.isFinite(n) ? n : null;
}

function names(list: Array<{ name?: string | null }> | null | undefined): string {
  return (list ?? [])
    .map((t) => (t?.name ?? '').trim())
    .filter(Boolean)
    .join(', ');
}

/** Beneficio de la fila: no tomadas no cuentan. */
function rowProfit(item: ExportItem): number | null {
  if (item.resultado === 'no_tomada') return null;
  return finite(item.pnlUsd) ? round(item.pnlUsd) : null;
}

// ── Tabla principal ──────────────────────────────────────────────────────────

const RESUMIDO_COLUMNS: ExportColumn[] = [
  { key: 'fecha', header: 'Hora', width: 18, kind: 'datetime' },
  { key: 'ticket', header: 'Ticket', width: 9, kind: 'text' },
  { key: 'simbolo', header: 'Símbolo', width: 10, kind: 'text' },
  { key: 'tipo', header: 'Tipo', width: 7, kind: 'text', tone: 'type' },
  { key: 'precio', header: 'Precio', width: 12, kind: 'number' },
  { key: 'sl', header: 'S / L', width: 12, kind: 'number' },
  { key: 'tp', header: 'T / P', width: 12, kind: 'number' },
  { key: 'rr', header: 'R:R', width: 9, kind: 'text' },
  { key: 'prob', header: 'Prob.', width: 8, kind: 'percent' },
  { key: 'resultado', header: 'Resultado', width: 12, kind: 'text', tone: 'result' },
  { key: 'beneficio', header: 'Beneficio', width: 12, kind: 'money', tone: 'profit' },
];

const DETALLADO_COLUMNS: ExportColumn[] = [
  { key: 'fecha', header: 'Fecha', width: 17, kind: 'datetime' },
  { key: 'ticket', header: 'Ticket', width: 8, kind: 'text' },
  { key: 'simbolo', header: 'Mercado', width: 12, kind: 'text' },
  { key: 'tier', header: 'Tier', width: 9, kind: 'text' },
  { key: 'sesgo', header: 'Sesgo', width: 11, kind: 'text' },
  { key: 'tipo', header: 'Tipo', width: 8, kind: 'text', tone: 'type' },
  { key: 'tasa', header: 'Tasa de acierto', width: 14, kind: 'text' },
  { key: 'prob', header: 'Probabilidad', width: 15, kind: 'percent' },
  { key: 'estado', header: 'Estado', width: 10, kind: 'text' },
  { key: 'precio', header: 'Precio', width: 11, kind: 'number' },
  { key: 'sl', header: 'S / L', width: 11, kind: 'number' },
  { key: 'tp', header: 'T / P', width: 11, kind: 'number' },
  { key: 'rr', header: 'R:R', width: 8, kind: 'text' },
  { key: 'resultado', header: 'Resultado', width: 14, kind: 'text', tone: 'result' },
  { key: 'beneficio', header: '$/PnL', width: 12, kind: 'money', tone: 'profit' },
  { key: 'direccion', header: 'Dirección', width: 12, kind: 'text' },
  { key: 'confluencias', header: 'Confluencias', width: 18, kind: 'text' },
  { key: 'comentario', header: 'Comentarios', width: 26, kind: 'text' },
  { key: 'motivo', header: 'Motivo entrada/salida', width: 26, kind: 'text' },
];

export function exportColumns(mode: ExportMode): ExportColumn[] {
  return mode === 'resumido' ? RESUMIDO_COLUMNS : DETALLADO_COLUMNS;
}

export function exportRow(
  item: ExportItem,
  mode: ExportMode,
  helpers: ExportRowHelpers
): Record<string, CellValue> {
  const type = helpers.tradeType(item);
  const base: Record<string, CellValue> = {
    fecha: item.createdAt,
    ticket: `#${item.id}`,
    simbolo: item.market.toUpperCase(),
    tipo: type ?? DASH,
    precio: entryPrice(item),
    sl: finite(item.plannedSl) ? item.plannedSl : null,
    tp: finite(item.plannedTp) ? item.plannedTp : null,
    rr: item.plannedRr?.trim() || DASH,
    prob: finite(item.scoreCombined) ? round(item.scoreCombined, 1) : null,
    resultado: resultLabel(item.resultado),
    beneficio: rowProfit(item),
  };
  if (mode === 'resumido') return base;
  return {
    ...base,
    tier: item.tier ?? DASH,
    sesgo: helpers.biasText(item),
    tasa: helpers.hitRate(item),
    estado: item.status ?? DASH,
    direccion: names(item.tags) || DASH,
    confluencias: names(item.confluencias) || DASH,
    comentario: item.comment?.trim() || '',
    motivo: item.motivoEntradaSalida?.trim() || '',
  };
}

/** Tabla principal en el mismo orden que la UI (más reciente arriba). */
export function exportTable(
  items: ExportItem[],
  mode: ExportMode,
  helpers: ExportRowHelpers
): ExportTable {
  const ordered = chronological(items).reverse();
  return {
    title: mode === 'resumido' ? 'Historial (resumido)' : 'Historial (detallado)',
    columns: exportColumns(mode),
    rows: ordered.map((it) => exportRow(it, mode, helpers)),
  };
}

export function exportTotals(items: ExportItem[]): ExportTotals {
  const out: ExportTotals = { ganadas: 0, perdidas: 0, noTomadas: 0, pendientes: 0, profit: null };
  let sum = 0;
  let has = false;
  for (const it of items) {
    if (it.resultado === 'ganada') out.ganadas++;
    else if (it.resultado === 'perdida') out.perdidas++;
    else if (it.resultado === 'no_tomada') out.noTomadas++;
    else out.pendientes++;
    const p = rowProfit(it);
    if (p != null) {
      sum += p;
      has = true;
    }
  }
  out.profit = has ? round(sum) : null;
  return out;
}

// ── KPIs extra ───────────────────────────────────────────────────────────────

export function extraKpis(items: ExportItem[]): ExtraKpis {
  const total = items.length;
  const closed = chronological(items).filter((i) => isClosed(i.resultado));
  const withPnl = closed.filter((i) => finite(i.pnlUsd));

  let best: TradeRef | null = null;
  let worst: TradeRef | null = null;
  const wins: number[] = [];
  const losses: number[] = [];
  for (const it of withPnl) {
    const pnl = round(it.pnlUsd as number);
    const ref: TradeRef = { id: it.id, market: it.market, createdAt: it.createdAt, pnl };
    if (!best || pnl > best.pnl) best = ref;
    if (!worst || pnl < worst.pnl) worst = ref;
    if (pnl > 0) wins.push(pnl);
    else if (pnl < 0) losses.push(Math.abs(pnl));
  }

  const avg = (xs: number[]) => (xs.length ? round(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
  const avgWin = avg(wins);
  const avgLossAbs = avg(losses);

  let maxWinStreak: number | null = null;
  if (closed.length) {
    let streak = 0;
    maxWinStreak = 0;
    for (const it of closed) {
      streak = it.resultado === 'ganada' ? streak + 1 : 0;
      if (streak > maxWinStreak) maxWinStreak = streak;
    }
  }

  const noTomadas = items.filter((i) => i.resultado === 'no_tomada').length;
  const marked = items.filter((i) => i.resultado != null).length;

  return {
    bestTrade: best,
    worstTrade: worst,
    avgWin,
    avgLoss: avgLossAbs == null ? null : -avgLossAbs,
    payoff: avgWin != null && avgLossAbs ? round(avgWin / avgLossAbs) : null,
    maxWinStreak,
    noTomadaPct: total ? round((noTomadas / total) * 100, 1) : null,
    markedPct: total ? round((marked / total) * 100, 1) : null,
    closedWithPnl: withPnl.length,
  };
}

export function formatMoney(v: number | null | undefined): string {
  if (!finite(v)) return DASH;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatUnit(v: number | null, unit: 'usd' | 'R' | null, digits = 2): string {
  if (!finite(v)) return 'n/d';
  if (unit === 'usd') return formatMoney(v);
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)} R`;
}

function signTone(v: number | null | undefined): KpiTone {
  if (!finite(v)) return 'neutral';
  return v > 0 ? 'ok' : v < 0 ? 'bad' : 'neutral';
}

export function kpiEntries(m: ExportMetricsLite, x: ExtraKpis): KpiEntry[] {
  const wr = m.winratePct;
  let wrTone: KpiTone = 'neutral';
  if (wr != null) wrTone = wr >= 55 ? 'ok' : wr >= 40 ? 'warn' : 'bad';
  let pfTone: KpiTone = 'neutral';
  if (m.profitFactor != null) pfTone = m.profitFactor >= 1.3 ? 'ok' : m.profitFactor >= 1 ? 'warn' : 'bad';
  const unitHint = m.pnlUnit === 'usd' ? 'en $ reales' : m.pnlUnit === 'R' ? 'estimado en R' : 'sin datos';

  return [
    { label: 'Tasa de acierto', value: wr == null ? 'n/d' : `${wr.toFixed(1)}%`, hint: `${m.wins} ganadas · ${m.losses} perdidas`, tone: wrTone },
    { label: 'PnL total', value: formatUnit(m.pnl, m.pnlUnit), hint: unitHint, tone: signTone(m.pnl) },
    { label: 'Profit factor', value: m.profitFactor == null ? 'n/d' : m.profitFactor.toFixed(2), hint: 'Ganancia bruta ÷ pérdida bruta', tone: pfTone },
    { label: 'Expectativa', value: formatUnit(m.expectancy, m.pnlUnit, 3), hint: 'Resultado medio por operación', tone: signTone(m.expectancy) },
    { label: 'Máx. drawdown', value: m.maxDrawdown == null ? 'n/d' : formatUnit(-Math.abs(m.maxDrawdown), m.pnlUnit), hint: 'Peor caída de equity', tone: m.maxDrawdown ? 'bad' : 'neutral' },
    { label: 'R:R planificado', value: m.avgRewardMultiple == null ? 'n/d' : `1:${m.avgRewardMultiple.toFixed(2)}`, hint: 'Media del plan', tone: 'neutral' },
    { label: 'Payoff real', value: x.payoff == null ? 'n/d' : x.payoff.toFixed(2), hint: 'Ganancia media ÷ pérdida media ($)', tone: x.payoff == null ? 'neutral' : x.payoff >= 1 ? 'ok' : 'warn' },
    { label: 'Ganancia media', value: formatMoney(x.avgWin), hint: 'Por operación ganadora', tone: signTone(x.avgWin) },
    { label: 'Pérdida media', value: formatMoney(x.avgLoss), hint: 'Por operación perdedora', tone: signTone(x.avgLoss) },
    { label: 'Mejor operación', value: x.bestTrade ? formatMoney(x.bestTrade.pnl) : 'n/d', hint: x.bestTrade ? `#${x.bestTrade.id} · ${x.bestTrade.market.toUpperCase()}` : 'Sin $/PnL', tone: signTone(x.bestTrade?.pnl) },
    { label: 'Peor operación', value: x.worstTrade ? formatMoney(x.worstTrade.pnl) : 'n/d', hint: x.worstTrade ? `#${x.worstTrade.id} · ${x.worstTrade.market.toUpperCase()}` : 'Sin $/PnL', tone: signTone(x.worstTrade?.pnl) },
    { label: 'Racha ganadora máx.', value: x.maxWinStreak == null ? 'n/d' : String(x.maxWinStreak), hint: 'Ganadas consecutivas', tone: 'ok' },
    { label: 'Racha perdedora máx.', value: m.maxConsecutiveLosses == null ? 'n/d' : String(m.maxConsecutiveLosses), hint: 'Perdidas consecutivas', tone: m.maxConsecutiveLosses ? 'bad' : 'neutral' },
    { label: 'Señales registradas', value: String(m.total), hint: `${m.closed} cerradas · ${m.unmarked} sin cerrar`, tone: 'neutral' },
    { label: 'Disciplina de registro', value: x.markedPct == null ? 'n/d' : `${x.markedPct.toFixed(1)}%`, hint: 'Filas con resultado marcado', tone: x.markedPct == null ? 'neutral' : x.markedPct >= 90 ? 'ok' : x.markedPct >= 60 ? 'warn' : 'bad' },
    { label: 'No tomadas', value: x.noTomadaPct == null ? 'n/d' : `${x.noTomadaPct.toFixed(1)}%`, hint: 'Señales filtradas por el trader', tone: 'neutral' },
  ];
}

// ── Desgloses ────────────────────────────────────────────────────────────────

export function groupStats(
  items: ExportItem[],
  keysOf: (item: ExportItem) => string[],
  order?: string[]
): GroupStat[] {
  const map = new Map<string, ExportItem[]>();
  for (const it of items) {
    for (const k of keysOf(it)) {
      const list = map.get(k);
      if (list) list.push(it);
      else map.set(k, [it]);
    }
  }
  const stats = [...map.entries()].map(([label, list]) => statFor(label, list));
  if (order) {
    const idx = (l: string) => {
      const i = order.indexOf(l);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return stats.sort((a, b) => idx(a.label) - idx(b.label) || a.label.localeCompare(b.label));
  }
  return stats.sort((a, b) => b.trades - a.trades || a.label.localeCompare(b.label));
}

function statFor(label: string, list: ExportItem[]): GroupStat {
  const t = exportTotals(list);
  const closed = t.ganadas + t.perdidas;
  let grossWin = 0;
  let grossLoss = 0;
  let pnlCount = 0;
  for (const it of list) {
    if (!isClosed(it.resultado) || !finite(it.pnlUsd)) continue;
    pnlCount++;
    if (it.pnlUsd > 0) grossWin += it.pnlUsd;
    else grossLoss += Math.abs(it.pnlUsd);
  }
  return {
    label,
    trades: list.length,
    ganadas: t.ganadas,
    perdidas: t.perdidas,
    noTomadas: t.noTomadas,
    pendientes: t.pendientes,
    winratePct: closed ? round((t.ganadas / closed) * 100, 1) : null,
    pnl: t.profit,
    avgPnl: pnlCount && t.profit != null ? round(t.profit / pnlCount) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
  };
}

const GROUP_COLUMNS = (firstHeader: string): ExportColumn[] => [
  { key: 'label', header: firstHeader, width: 30, kind: 'text' },
  { key: 'trades', header: 'Señales', width: 9, kind: 'int' },
  { key: 'ganadas', header: 'Ganadas', width: 9, kind: 'int' },
  { key: 'perdidas', header: 'Perdidas', width: 9, kind: 'int' },
  { key: 'noTomadas', header: 'No tomadas', width: 11, kind: 'int' },
  { key: 'pendientes', header: 'Pendientes', width: 11, kind: 'int' },
  { key: 'winrate', header: 'Acierto', width: 9, kind: 'percent' },
  { key: 'pnl', header: 'PnL $', width: 12, kind: 'money', tone: 'profit' },
  { key: 'avgPnl', header: 'PnL medio $', width: 12, kind: 'money', tone: 'profit' },
  { key: 'pf', header: 'Profit factor', width: 12, kind: 'ratio' },
];

export function groupTable(title: string, firstHeader: string, stats: GroupStat[]): ExportTable {
  return {
    title,
    columns: GROUP_COLUMNS(firstHeader),
    rows: stats.map((s) => ({
      label: s.label,
      trades: s.trades,
      ganadas: s.ganadas,
      perdidas: s.perdidas,
      noTomadas: s.noTomadas,
      pendientes: s.pendientes,
      winrate: s.winratePct,
      pnl: s.pnl,
      avgPnl: s.avgPnl,
      pf: s.profitFactor,
    })),
  };
}

export const SESSION_ORDER = [
  'Asia (19:00–02:00 NY)',
  'Londres (02:00–07:00 NY)',
  'NY AM (07:00–12:00 NY)',
  'NY PM (12:00–17:00 NY)',
  'Cierre / rollover (17:00–19:00 NY)',
];

export const WEEKDAY_ORDER = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const WEEKDAY_BY_INDEX = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Partes de fecha en una zona horaria (sin depender del idioma del sistema). */
export function zonedParts(iso: string, timeZone: string): { year: number; month: number; day: number; hour: number; weekday: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    weekday: wd < 0 ? 0 : wd,
  };
}

export function sessionOf(iso: string): string | null {
  const p = zonedParts(iso, 'America/New_York');
  if (!p) return null;
  const h = p.hour;
  if (h >= 19 || h < 2) return SESSION_ORDER[0];
  if (h < 7) return SESSION_ORDER[1];
  if (h < 12) return SESSION_ORDER[2];
  if (h < 17) return SESSION_ORDER[3];
  return SESSION_ORDER[4];
}

export function weekdayOf(iso: string): string | null {
  const p = zonedParts(iso, 'America/Bogota');
  return p ? WEEKDAY_BY_INDEX[p.weekday] : null;
}

export function monthOf(iso: string): string | null {
  const p = zonedParts(iso, 'America/Bogota');
  return p ? `${p.year}-${String(p.month).padStart(2, '0')}` : null;
}

const one = (v: string | null): string[] => (v ? [v] : []);

export function breakdownTables(items: ExportItem[]): ExportTable[] {
  const tables: ExportTable[] = [
    groupTable('Por mercado', 'Mercado', groupStats(items, (i) => [i.market.toUpperCase()])),
    groupTable('Por sesión (hora NY)', 'Sesión', groupStats(items, (i) => one(sessionOf(i.createdAt)), SESSION_ORDER)),
    groupTable('Por día (hora Colombia)', 'Día', groupStats(items, (i) => one(weekdayOf(i.createdAt)), WEEKDAY_ORDER)),
    groupTable(
      'Por mes',
      'Mes',
      groupStats(items, (i) => one(monthOf(i.createdAt))).sort((a, b) => b.label.localeCompare(a.label))
    ),
    groupTable(
      'Por dirección',
      'Dirección',
      groupStats(items, (i) => {
        const n = (i.tags ?? []).map((t) => (t?.name ?? '').trim()).filter(Boolean);
        return n.length ? n : ['Sin dirección'];
      })
    ),
    groupTable(
      'Por confluencia',
      'Confluencia',
      groupStats(items, (i) => {
        const n = (i.confluencias ?? []).map((t) => (t?.name ?? '').trim()).filter(Boolean);
        return n.length ? n : ['Sin confluencias'];
      })
    ),
  ];
  return tables.filter((t) => t.rows.length > 0);
}

// ── Curva de equity ──────────────────────────────────────────────────────────

/**
 * Filas de la curva de equity alineadas con metrics.equityCurve
 * (misma serie: cerradas en orden cronológico). null si no hay serie completa.
 */
export function equityTable(items: ExportItem[], m: ExportMetricsLite): ExportTable | null {
  const closed = chronological(items).filter((i) => isClosed(i.resultado));
  const curve = m.equityCurve ?? [];
  if (!closed.length || curve.length !== closed.length || !m.pnlUnit) return null;
  const unitKind: CellKind = m.pnlUnit === 'usd' ? 'money' : 'number';
  const unitLabel = m.pnlUnit === 'usd' ? '$' : 'R';
  let peak = 0;
  let prev = 0;
  const rows = closed.map((it, i) => {
    const eq = curve[i];
    const delta = round(eq - prev, 2);
    prev = eq;
    if (eq > peak) peak = eq;
    return {
      n: i + 1,
      fecha: it.createdAt,
      ticket: `#${it.id}`,
      simbolo: it.market.toUpperCase(),
      resultado: resultLabel(it.resultado),
      delta,
      equity: eq,
      drawdown: round(eq - peak, 2),
    } satisfies Record<string, CellValue>;
  });
  return {
    title: `Curva de equity (${unitLabel})`,
    columns: [
      { key: 'n', header: 'N.º', width: 6, kind: 'int' },
      { key: 'fecha', header: 'Fecha', width: 18, kind: 'datetime' },
      { key: 'ticket', header: 'Ticket', width: 9, kind: 'text' },
      { key: 'simbolo', header: 'Símbolo', width: 10, kind: 'text' },
      { key: 'resultado', header: 'Resultado', width: 12, kind: 'text', tone: 'result' },
      { key: 'delta', header: `Resultado ${unitLabel}`, width: 13, kind: unitKind, tone: 'profit' },
      { key: 'equity', header: `Equity ${unitLabel}`, width: 13, kind: unitKind, tone: 'profit' },
      { key: 'drawdown', header: `Drawdown ${unitLabel}`, width: 13, kind: unitKind, tone: 'profit' },
    ],
    rows,
  };
}

// ── Formato y ensamblado ─────────────────────────────────────────────────────

export function formatDateTime(iso: string, timeZone = 'America/Bogota'): string {
  const p = zonedParts(iso, timeZone);
  if (!p) return iso;
  const d = new Date(iso);
  const min = new Intl.DateTimeFormat('en-US', { timeZone, minute: '2-digit' }).format(d).padStart(2, '0');
  return `${p.year}.${String(p.month).padStart(2, '0')}.${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${min}`;
}

function formatNumber(v: number): string {
  const abs = Math.abs(v);
  const digits = abs < 10 ? 5 : abs < 1000 ? 3 : 2;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** Texto de una celda para PDF / vistas de texto. */
export function formatCell(value: CellValue, kind: CellKind): string {
  if (value == null || value === '') return kind === 'text' ? '' : DASH;
  if (typeof value === 'string') return kind === 'datetime' ? formatDateTime(value) : value;
  switch (kind) {
    case 'int':
      return String(Math.round(value));
    case 'money':
      return formatMoney(value);
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'ratio':
      return value.toFixed(2);
    case 'number':
      return formatNumber(value);
    default:
      return String(value);
  }
}

export function exportFileName(
  mode: ExportMode,
  marketLabel: string,
  ext: 'xlsx' | 'pdf',
  now = new Date(),
  fileTag = ''
): string {
  const p = zonedParts(now.toISOString(), 'America/Bogota');
  const pad = (n: number) => String(n).padStart(2, '0');
  const min = pad(now.getUTCMinutes());
  const stamp = p ? `${p.year}${pad(p.month)}${pad(p.day)}-${pad(p.hour)}${min}` : String(now.getTime());
  const market = marketLabel.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'todos';
  const tag = fileTag.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `flash-signals-historial-${market}-${mode}${tag ? `-${tag}` : ''}-${stamp}.${ext}`;
}

export function buildExportBundle(
  items: ExportItem[],
  opts: {
    mode: ExportMode;
    marketLabel: string;
    metrics: ExportMetricsLite;
    helpers: ExportRowHelpers;
    scopeLabel?: string;
    fileTag?: string;
    now?: Date;
  }
): ExportBundle {
  const extra = extraKpis(items);
  return {
    mode: opts.mode,
    marketLabel: opts.marketLabel,
    scopeLabel: opts.scopeLabel ?? 'Todas las páginas',
    fileTag: opts.fileTag ?? '',
    generatedAt: opts.now ?? new Date(),
    table: exportTable(items, opts.mode, opts.helpers),
    totals: exportTotals(items),
    kpis: kpiEntries(opts.metrics, extra),
    breakdowns: breakdownTables(items),
    equity: equityTable(items, opts.metrics),
    equityCurve: opts.metrics.equityCurve ?? [],
    pnlUnit: opts.metrics.pnlUnit,
    notes: opts.metrics.notes ?? [],
  };
}
