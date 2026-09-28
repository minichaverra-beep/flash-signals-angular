import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPrice,
  formatProfit,
  summaryRow,
  summaryTotals,
  summaryTradeType,
} from './historial-summary.ts';

describe('historial-summary (vista Resumido tipo MT5)', () => {
  it('summaryTradeType usa niveles del plan antes que tags y bias', () => {
    assert.equal(
      summaryTradeType({ id: 1, market: 'btc', plannedEntry: 100, plannedSl: 90, bias: 'bearish' }),
      'buy'
    );
    assert.equal(
      summaryTradeType({ id: 2, market: 'btc', plannedEntry: 100, plannedSl: 110 }),
      'sell'
    );
    assert.equal(
      summaryTradeType({ id: 3, market: 'btc', tags: [{ name: 'SHORT' }] }),
      'sell'
    );
    assert.equal(summaryTradeType({ id: 4, market: 'btc', bias: 'bullish' }), 'buy');
    assert.equal(summaryTradeType({ id: 5, market: 'btc', bias: 'auto' }), null);
  });

  it('formatPrice ajusta decimales por magnitud', () => {
    assert.equal(formatPrice(84164.5), '84164.50');
    assert.equal(formatPrice(1.0843), '1.08430');
    assert.equal(formatPrice(null), '—');
  });

  it('formatProfit con signo', () => {
    assert.equal(formatProfit(125.5), '+125.50');
    assert.equal(formatProfit(-40), '-40.00');
    assert.equal(formatProfit(null), '—');
  });

  it('summaryRow: no tomada no muestra beneficio', () => {
    const r = summaryRow({
      id: 9,
      market: 'btc',
      plannedEntry: 84164.5,
      plannedSl: 84224.5,
      plannedTp: 84044.5,
      plannedRr: '1:2',
      resultado: 'no_tomada',
      pnlUsd: 50,
    });
    assert.equal(r.typeLabel, 'sell');
    assert.equal(r.sl, '84224.50');
    assert.equal(r.resultLabel, 'No tomada');
    assert.equal(r.profit, '—');
  });

  it('summaryTotals suma PnL excluyendo no tomadas', () => {
    const t = summaryTotals([
      { id: 1, market: 'btc', resultado: 'ganada', pnlUsd: 100 },
      { id: 2, market: 'btc', resultado: 'perdida', pnlUsd: -40 },
      { id: 3, market: 'btc', resultado: 'no_tomada', pnlUsd: 999 },
      { id: 4, market: 'btc' },
    ]);
    assert.equal(t.profit, '+60.00');
    assert.equal(t.profitTone, 'pos');
    assert.deepEqual(
      [t.ganadas, t.perdidas, t.noTomadas, t.pendientes],
      [1, 1, 1, 1]
    );
  });
});
