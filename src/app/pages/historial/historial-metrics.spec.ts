import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHistoryMetrics,
  formatMetric,
  formatPnlMoneyInput,
  type HistoryMetricSource,
} from './historial-metrics.ts';

function row(
  partial: Partial<HistoryMetricSource> & Pick<HistoryMetricSource, 'id'>
): HistoryMetricSource {
  return {
    createdAt: partial.createdAt ?? `2026-01-${String(partial.id).padStart(2, '0')}T12:00:00.000Z`,
    resultado: partial.resultado ?? null,
    plannedRr: partial.plannedRr ?? null,
    pnlUsd: partial.pnlUsd ?? null,
    id: partial.id,
  };
}

describe('computeHistoryMetrics', () => {
  it('lista vacía → todo n/d / ceros', () => {
    const m = computeHistoryMetrics([]);
    assert.equal(m.closed, 0);
    assert.equal(m.winratePct, null);
    assert.equal(m.maxConsecutiveLosses, null);
    assert.equal(m.pnl, null);
    assert.equal(m.pnlUnit, null);
    assert.equal(m.pnlR, null);
    assert.equal(m.avgRewardMultiple, null);
  });

  it('winrate y rachas solo desde resultado', () => {
    const m = computeHistoryMetrics([
      row({ id: 1, resultado: 'ganada', plannedRr: '1:2' }),
      row({ id: 2, resultado: 'perdida' }),
      row({ id: 3, resultado: 'perdida' }),
      row({ id: 4, resultado: 'ganada', plannedRr: '1:2' }),
      row({ id: 5, resultado: null }),
    ]);
    assert.equal(m.closed, 4);
    assert.equal(m.wins, 2);
    assert.equal(m.losses, 2);
    assert.equal(m.winratePct, 50);
    assert.equal(m.maxConsecutiveLosses, 2);
  });

  it('no_tomada no cuenta en cerradas ni altera winrate/PnL', () => {
    const m = computeHistoryMetrics([
      row({ id: 1, resultado: 'ganada', plannedRr: '1:2', pnlUsd: 100 }),
      row({ id: 2, resultado: 'no_tomada', plannedRr: '1:3', pnlUsd: 999 }),
      row({ id: 3, resultado: 'perdida', pnlUsd: -40 }),
      row({ id: 4, resultado: null }),
    ]);
    assert.equal(m.closed, 2);
    assert.equal(m.wins, 1);
    assert.equal(m.losses, 1);
    assert.equal(m.unmarked, 2);
    assert.equal(m.winratePct, 50);
    assert.equal(m.pnlUnit, 'usd');
    assert.equal(m.pnl, 60);
    assert.equal(m.maxConsecutiveLosses, 1);
  });

  it('estima PnL/PF/expectativa/DD en R si todas las ganadas tienen R:R', () => {
    const m = computeHistoryMetrics([
      row({ id: 1, resultado: 'ganada', plannedRr: '1:2' }), // +2
      row({ id: 2, resultado: 'perdida' }), // -1
      row({ id: 3, resultado: 'ganada', plannedRr: '2' }), // +2
    ]);
    assert.equal(m.pnlUnit, 'R');
    assert.equal(m.pnl, 3);
    assert.equal(m.pnlR, 3);
    assert.equal(m.profitFactor, 4);
    assert.equal(m.expectancy, 1);
    assert.equal(m.expectancyR, 1);
    assert.equal(m.maxDrawdown, 1);
    assert.equal(m.maxDrawdownR, 1);
    assert.equal(m.avgRewardMultiple, 2);
  });

  it('sin R:R en ganadas → métricas en R quedan n/d (no inventa)', () => {
    const m = computeHistoryMetrics([
      row({ id: 1, resultado: 'ganada' }),
      row({ id: 2, resultado: 'perdida' }),
    ]);
    assert.equal(m.winratePct, 50);
    assert.equal(m.pnl, null);
    assert.equal(m.pnlUnit, null);
    assert.equal(m.pnlR, null);
    assert.equal(m.profitFactor, null);
    assert.equal(m.expectancy, null);
    assert.equal(m.maxDrawdown, null);
    assert.ok(m.notes.some((n) => /n\/d/i.test(n)));
  });

  it('prefiere PnL en $ cuando todas las cerradas tienen pnlUsd', () => {
    const m = computeHistoryMetrics([
      row({ id: 1, resultado: 'ganada', plannedRr: '1:2', pnlUsd: 100 }),
      row({ id: 2, resultado: 'perdida', pnlUsd: -40 }),
      row({ id: 3, resultado: 'ganada', pnlUsd: 50 }),
    ]);
    assert.equal(m.pnlUnit, 'usd');
    assert.equal(m.pnl, 110);
    assert.equal(m.pnlR, null); // no alias R cuando es $
    assert.equal(m.profitFactor, 3.75); // 150/40
    assert.equal(m.expectancy, Math.round((110 / 3) * 1000) / 1000);
    assert.equal(m.maxDrawdown, 40);
    assert.deepEqual(m.equityCurve, [100, 60, 110]);
  });

  it('PnL $ incompleto no mezcla con R; cae a R si hay R:R', () => {
    const m = computeHistoryMetrics([
      row({ id: 1, resultado: 'ganada', plannedRr: '1:2', pnlUsd: 100 }),
      row({ id: 2, resultado: 'perdida' }), // sin $
    ]);
    assert.equal(m.pnlUnit, 'R');
    assert.equal(m.pnl, 1); // +2 -1
    assert.ok(m.notes.some((n) => /incompleto/i.test(n)));
  });
});

describe('formatMetric / formatPnlMoneyInput', () => {
  it('devuelve n/d si null', () => {
    assert.equal(formatMetric(null), 'n/d');
    assert.equal(formatMetric(12.5, { suffix: '%' }), '12.50%');
  });

  it('formatea celda $/PnL', () => {
    assert.equal(formatPnlMoneyInput(null), '');
    assert.equal(formatPnlMoneyInput(12.5), '12.50');
    assert.equal(formatPnlMoneyInput(-40), '-40.00');
  });
});
