/**
 * Duplicar operación (segunda orden con el mismo lote) y resultado conjunto en Recalcular.
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { buildDuplicateOrder, combineAnnotations, reconcileOrder, pushDuplicateOrder, pushOrder } = require('./mt5');

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

  it('expirada → vuelve a colocar la LIMIT con los niveles conocidos del envío', () => {
    const { order } = buildDuplicateOrder(sent, { state: 'expired', symbol: 'BTCUSDm' });
    assert.deepEqual(order, {
      symbol: 'BTCUSDm', side: 'LONG', volume: 0.05, manual: true,
      sl: 59500, tp: 61000, order_mode: 'limit', entry: 60000,
    });
  });

  it('no duplica operaciones cerradas o canceladas', () => {
    for (const state of ['closed', 'canceled', undefined]) {
      assert.match(buildDuplicateOrder(sent, { state }).error, /no se puede duplicar/);
    }
  });
});

describe('pushDuplicateOrder: exento de los límites diarios', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const settings = {
    bridgeUrl: 'http://bridge.test', riskPct: 0.5, volume: 0, maxDeviationPct: 1, expiryMinutes: 60,
    deviationPoints: 20, allowMultiple: true, maxTradesPerDay: 3, maxDailyDrawdownPct: 4,
  };

  function captureBody() {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, order: 1 }), { status: 200 });
    };
    return calls;
  }

  it('el duplicado no envía max_trades_per_day ni max_daily_dd_pct al puente', async () => {
    const calls = captureBody();
    const { order } = buildDuplicateOrder(sent, { state: 'open', symbol: 'BTCUSDm', volume: 0.05, sl: 59500, tp: 61000 });
    await pushDuplicateOrder(order, { clientId: 'h1d' }, settings);
    const body = calls[0];
    assert.equal('max_trades_per_day' in body, false);
    assert.equal('max_daily_dd_pct' in body, false);
    assert.equal(body.client_id, 'h1d');
    assert.equal(body.manual, true);
    assert.equal(body.volume, 0.05);
  });

  it('una orden normal (pushOrder) sigue llevando los límites del perfil', async () => {
    const calls = captureBody();
    await pushOrder({ symbol: 'BTCUSDm', side: 'LONG', entry: 60000, sl: 59500, tp: 61000 }, { clientId: 'h1' }, settings);
    assert.equal(calls[0].max_trades_per_day, 3);
    assert.equal(calls[0].max_daily_dd_pct, 4);
  });
});

describe('reconcileOrder + combineAnnotations con órdenes expiradas', () => {
  it('expirada cuenta como no tomada', () => {
    assert.deepEqual(reconcileOrder(sent, { state: 'expired' }).annotation, { resultado: 'no_tomada' });
  });

  it('original expirada + duplicado ganado → ganada con el PnL del duplicado', () => {
    const main = reconcileOrder(sent, { state: 'expired' }).annotation;
    const dup = reconcileOrder(sent, { state: 'closed', profit: 12.5 }).annotation;
    assert.deepEqual(combineAnnotations(main, dup), { resultado: 'ganada', pnlUsd: 12.5 });
  });

  it('original y duplicado expirados → no tomada; duplicado aún pendiente → sin resultado', () => {
    const expired = reconcileOrder(sent, { state: 'expired' }).annotation;
    assert.deepEqual(combineAnnotations(expired, expired), { resultado: 'no_tomada' });
    assert.equal(combineAnnotations(expired, reconcileOrder(sent, { state: 'pending' }).annotation), null);
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
