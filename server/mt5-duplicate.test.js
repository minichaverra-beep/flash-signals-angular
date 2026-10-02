/**
 * Duplicar operación (segunda orden con el mismo lote) y resultado conjunto en Recalcular.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildDuplicateOrder, combineAnnotations } = require('./mt5');

const sent = { side: 'LONG', symbol: 'BTCUSDm', volume: 0.05, price: 60000, sl: 59500, tp: 61000 };

describe('buildDuplicateOrder', () => {
  it('pendiente → LIMIT con el mismo lote y los niveles actuales de MT5', () => {
    const { order } = buildDuplicateOrder(sent, {
      state: 'pending', symbol: 'BTCUSDm', volume: 0.05, entry: 60100, sl: 59400, tp: 61200,
    });
    assert.deepEqual(order, {
      symbol: 'BTCUSDm', side: 'LONG', volume: 0.05, manual: true,
      sl: 59400, tp: 61200, order_mode: 'limit', entry: 60100,
    });
  });

  it('abierta → mercado con el mismo SL/TP', () => {
    const { order } = buildDuplicateOrder(sent, { state: 'open', symbol: 'BTCUSDm', volume: 0.05, sl: 59500, tp: 61000 });
    assert.equal(order.order_mode, 'market');
    assert.equal(order.entry, undefined);
    assert.equal(order.volume, 0.05);
  });

  it('no duplica operaciones terminadas', () => {
    for (const state of ['closed', 'canceled', 'expired']) {
      assert.match(buildDuplicateOrder(sent, { state }).error, /no se puede duplicar/);
    }
  });
});

describe('combineAnnotations', () => {
  it('espera a que terminen las dos', () => {
    assert.equal(combineAnnotations({ resultado: 'ganada', pnlUsd: 5 }, null), null);
    assert.equal(combineAnnotations(null, { resultado: 'perdida', pnlUsd: -3 }), null);
  });

  it('suma el PnL y decide el resultado por el total', () => {
    assert.deepEqual(
      combineAnnotations({ resultado: 'ganada', pnlUsd: 5.1 }, { resultado: 'perdida', pnlUsd: -2.05 }),
      { resultado: 'ganada', pnlUsd: 3.05 }
    );
    assert.deepEqual(
      combineAnnotations({ resultado: 'perdida', pnlUsd: -4 }, { resultado: 'no_tomada' }),
      { resultado: 'perdida', pnlUsd: -4 }
    );
  });

  it('no tomada solo si ninguna se ejecutó', () => {
    assert.deepEqual(combineAnnotations({ resultado: 'no_tomada' }, { resultado: 'no_tomada' }), { resultado: 'no_tomada' });
  });
});
