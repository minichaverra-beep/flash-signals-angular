import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportBundle,
  equityTable,
  exportColumns,
  exportFileName,
  exportRow,
  exportTable,
  exportTotals,
  extraKpis,
  formatCell,
  formatMoney,
  groupStats,
  sessionOf,
  weekdayOf,
  type ExportItem,
  type ExportMetricsLite,
  type ExportRowHelpers,
} from './historial-export.ts';

const helpers: ExportRowHelpers = {
  tradeType: (i) => (i.plannedSl != null && i.plannedEntry != null ? (i.plannedSl < i.plannedEntry ? 'buy' : 'sell') : null),
  biasText: (i) => i.bias ?? 'Auto',
  hitRate: (i) => i.winrate ?? '—',
};

const items: ExportItem[] = [
  // Martes 2026-09-22 08:30 NY (12:30 UTC) → NY AM
  { id: 1, createdAt: '2026-09-22T12:30:00Z', market: 'us30', plannedEntry: 42450, plannedSl: 42315, plannedTp: 42850, plannedRr: '1:3', scoreCombined: 71.25, resultado: 'ganada', pnlUsd: 300, confluencias: [{ name: 'CRT' }, { name: 'FVG' }], tags: [{ name: 'LONG' }] },
  // Martes 03:00 NY (07:00 UTC) → Londres
  { id: 2, createdAt: '2026-09-22T07:00:00Z', market: 'xauusd', plannedEntry: 3992, plannedSl: 4001, resultado: 'perdida', pnlUsd: -100, confluencias: [{ name: 'CRT' }] },
  // Miércoles 20:00 NY (00:00 UTC jueves) → Asia
  { id: 3, createdAt: '2026-09-24T00:00:00Z', market: 'btc', resultado: 'no_tomada', pnlUsd: 50 },
  { id: 4, createdAt: '2026-09-24T15:00:00Z', market: 'us30', resultado: 'ganada', pnlUsd: 150, confluencias: [{ name: 'FVG' }] },
  { id: 5, createdAt: '2026-09-25T15:00:00Z', market: 'us30', resultado: null, comment: 'pendiente' },
];

const metrics: ExportMetricsLite = {
  total: 5,
  closed: 3,
  wins: 2,
  losses: 1,
  unmarked: 2,
  winratePct: 66.7,
  maxConsecutiveLosses: 1,
  avgRewardMultiple: 3,
  pnl: 350,
  pnlUnit: 'usd',
  profitFactor: 4.5,
  expectancy: 116.667,
  maxDrawdown: 100,
  // Orden cronológico de cerradas: #2 (-100), #1 (+300), #4 (+150)
  equityCurve: [-100, 200, 350],
  notes: ['nota'],
};

describe('historial-export (Excel / PDF)', () => {
  it('columnas según modo: resumido tipo MT5 y detallado con anotaciones', () => {
    const r = exportColumns('resumido').map((c) => c.key);
    assert.deepEqual(r, ['fecha', 'ticket', 'simbolo', 'tipo', 'precio', 'sl', 'tp', 'rr', 'prob', 'resultado', 'beneficio']);
    const d = exportColumns('detallado').map((c) => c.key);
    for (const k of ['sesgo', 'tasa', 'direccion', 'confluencias', 'comentario', 'motivo']) assert.ok(d.includes(k), k);
  });

  it('exportRow: valores numéricos crudos y no tomada sin beneficio', () => {
    const row = exportRow(items[0], 'resumido', helpers);
    assert.equal(row['ticket'], '#1');
    assert.equal(row['simbolo'], 'US30');
    assert.equal(row['tipo'], 'buy');
    assert.equal(row['precio'], 42450);
    assert.equal(row['prob'], 71.3);
    assert.equal(row['beneficio'], 300);
    assert.equal(exportRow(items[2], 'resumido', helpers)['beneficio'], null);
    const det = exportRow(items[0], 'detallado', helpers);
    assert.equal(det['confluencias'], 'CRT, FVG');
    assert.equal(det['direccion'], 'LONG');
  });

  it('exportTable ordena como la UI (más reciente arriba)', () => {
    const t = exportTable(items, 'resumido', helpers);
    assert.deepEqual(t.rows.map((r) => r['ticket']), ['#5', '#4', '#3', '#1', '#2']);
  });

  it('exportTotals excluye no tomadas del beneficio', () => {
    assert.deepEqual(exportTotals(items), { ganadas: 2, perdidas: 1, noTomadas: 1, pendientes: 1, profit: 350 });
  });

  it('extraKpis: mejor/peor, payoff, rachas y disciplina', () => {
    const x = extraKpis(items);
    assert.equal(x.bestTrade?.id, 1);
    assert.equal(x.worstTrade?.id, 2);
    assert.equal(x.avgWin, 225);
    assert.equal(x.avgLoss, -100);
    assert.equal(x.payoff, 2.25);
    assert.equal(x.maxWinStreak, 2);
    assert.equal(x.noTomadaPct, 20);
    assert.equal(x.markedPct, 80);
  });

  it('groupStats agrupa multi-etiqueta (confluencias) con acierto y PF', () => {
    const stats = groupStats(items, (i) => (i.confluencias ?? []).map((c) => c.name ?? ''));
    const crt = stats.find((s) => s.label === 'CRT');
    const fvg = stats.find((s) => s.label === 'FVG');
    assert.equal(crt?.trades, 2);
    assert.equal(crt?.winratePct, 50);
    assert.equal(crt?.profitFactor, 3);
    assert.equal(fvg?.winratePct, 100);
    assert.equal(fvg?.profitFactor, null);
  });

  it('sesiones en hora NY y días en hora Colombia', () => {
    assert.equal(sessionOf('2026-09-22T12:30:00Z'), 'NY AM (07:00–12:00 NY)');
    assert.equal(sessionOf('2026-09-22T07:00:00Z'), 'Londres (02:00–07:00 NY)');
    assert.equal(sessionOf('2026-09-24T00:00:00Z'), 'Asia (19:00–02:00 NY)');
    assert.equal(weekdayOf('2026-09-24T00:00:00Z'), 'Miércoles');
  });

  it('equityTable alinea la curva con las cerradas cronológicas y calcula drawdown', () => {
    const t = equityTable(items, metrics);
    assert.ok(t);
    assert.deepEqual(t.rows.map((r) => r['ticket']), ['#2', '#1', '#4']);
    assert.deepEqual(t.rows.map((r) => r['delta']), [-100, 300, 150]);
    assert.deepEqual(t.rows.map((r) => r['drawdown']), [-100, 0, 0]);
    assert.equal(equityTable(items, { ...metrics, equityCurve: [1] }), null);
  });

  it('formatCell y formatMoney', () => {
    assert.equal(formatMoney(1234.5), '+$1,234.50');
    assert.equal(formatMoney(-40), '-$40.00');
    assert.equal(formatCell(null, 'money'), '—');
    assert.equal(formatCell(55.55, 'percent'), '55.5%');
    assert.equal(formatCell('2026-09-22T12:30:00Z', 'datetime'), '2026.09.22 07:30');
  });

  it('exportFileName incluye mercado, modo y fecha Colombia', () => {
    const name = exportFileName('resumido', 'US30', 'xlsx', new Date('2026-09-29T15:26:00Z'));
    assert.equal(name, 'flash-signals-historial-us30-resumido-20260929-1026.xlsx');
    const paged = exportFileName('detallado', 'Todos', 'pdf', new Date('2026-09-29T15:26:00Z'), 'p2');
    assert.equal(paged, 'flash-signals-historial-todos-detallado-p2-20260929-1026.pdf');
  });

  it('buildExportBundle ensambla tabla, KPIs, desgloses y equity', () => {
    const b = buildExportBundle(items, { mode: 'detallado', marketLabel: 'Todos', metrics, helpers, now: new Date('2026-09-29T15:00:00Z') });
    assert.equal(b.table.rows.length, 5);
    assert.ok(b.kpis.length >= 12);
    assert.ok(b.breakdowns.some((t) => t.title === 'Por mercado'));
    assert.ok(b.equity);
    assert.equal(b.kpis[0].value, '66.7%');
    assert.equal(b.scopeLabel, 'Todas las páginas');
    assert.equal(b.fileTag, '');
    const paged = buildExportBundle(items.slice(0, 2), { mode: 'resumido', marketLabel: 'Todos', metrics, helpers, scopeLabel: 'Página 1 de 3 · 2 por página', fileTag: 'p1' });
    assert.equal(paged.table.rows.length, 2);
    assert.equal(paged.scopeLabel, 'Página 1 de 3 · 2 por página');
  });
});
