/**
 * Tests de mapeo señal → orden MT5 (sin puente ni terminal).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.MT5_SETTINGS_PATH = path.join(os.tmpdir(), `mt5-test-${process.pid}-missing.json`);
const { buildManualOrder, buildOrderFromSummary, symbolFor } = require('./mt5');

const plan = (entry, sl, tp) => ({ verdict: 'ENTRAR', planDetails: { entry, sl, tp } });

describe('buildOrderFromSummary', () => {
  it('LONG cuando SL < entry < TP (plan XAUUSD real)', () => {
    const { order } = buildOrderFromSummary('xauusd', plan('4165.57', '4159.57', '4177.57'));
    assert.deepEqual(order, { symbol: 'XAUUSD', side: 'LONG', entry: 4165.57, sl: 4159.57, tp: 4177.57 });
  });

  it('SHORT cuando TP < entry < SL', () => {
    const { order } = buildOrderFromSummary('btc', plan('84282.9', '84423.6', '84001.6'));
    assert.equal(order.side, 'SHORT');
    assert.equal(order.symbol, 'BTCUSD');
  });

  it('no envía si el veredicto no es ENTRAR', () => {
    const res = buildOrderFromSummary('us30', { ...plan('51677', '51617', '51797'), verdict: 'ESPERAR' });
    assert.equal(res.order, undefined);
    assert.match(res.skip, /ESPERAR/);
  });

  it('descarta planes incoherentes o incompletos', () => {
    assert.match(buildOrderFromSummary('us30', plan('51677', '51700', '51797')).skip, /incoherente/);
    assert.match(buildOrderFromSummary('us30', plan('51677', null, '51797')).skip, /Entry\/SL\/TP/);
    assert.match(buildOrderFromSummary('us30', null).skip, /Sin resumen/);
  });

  it('usa el símbolo de la configuración', () => {
    const settings = { symbols: { us30: 'US30.cash' } };
    assert.equal(symbolFor('us30', settings), 'US30.cash');
    const { order } = buildOrderFromSummary('us30', plan('51677', '51617', '51797'), settings);
    assert.equal(order.symbol, 'US30.cash');
  });
});

describe('buildManualOrder', () => {
  const settings = { symbols: { xauusd: 'XAUUSDm' }, volume: null };

  it('mercado sin SL/TP con lotes fijos (sin chequeos de señal)', () => {
    const { order } = buildManualOrder({ market: 'xauusd', side: 'long', volume: '0.01' }, settings);
    assert.deepEqual(order, { symbol: 'XAUUSDm', side: 'LONG', manual: true, order_mode: 'market', volume: 0.01 });
  });

  it('acepta SL/TP incoherentes y símbolo libre: los valida MT5', () => {
    const { order } = buildManualOrder(
      { symbol: 'EURUSDm', side: 'SHORT', orderMode: 'limit', entry: 1.1, sl: 1.05, tp: 1.2 },
      settings
    );
    assert.equal(order.symbol, 'EURUSDm');
    assert.equal(order.order_mode, 'limit');
    assert.equal(order.sl, 1.05);
  });

  it('rechaza entradas que el puente no puede ejecutar', () => {
    assert.match(buildManualOrder({ market: 'xauusd', side: 'BUY', volume: 1 }, settings).error, /side/);
    assert.match(buildManualOrder({ market: 'xauusd', side: 'LONG', orderMode: 'stop', volume: 1 }, settings).error, /entry/);
    assert.match(buildManualOrder({ market: 'xauusd', side: 'LONG' }, settings).error, /volume/);
    assert.match(buildManualOrder({ symbol: 'X; rm', side: 'LONG', volume: 1 }, settings).error, /symbol/);
    assert.match(buildManualOrder({ market: 'xauusd', side: 'LONG', volume: -1 }, settings).error, /volume/);
  });
});
