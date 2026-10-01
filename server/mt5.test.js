/**
 * Tests de mapeo señal → orden MT5 (sin puente ni terminal).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.MT5_SETTINGS_PATH = path.join(os.tmpdir(), `mt5-test-${process.pid}-missing.json`);
const { buildManualOrder, buildOrderFromSummary, reconcileOrder, symbolFor } = require('./mt5');

const plan = (entry, sl, tp) => ({ verdict: 'ENTRAR', planDetails: { entry, sl, tp } });

describe('buildOrderFromSummary', () => {
  it('LONG cuando SL < entry < TP, con +30 pips de SL/TP por defecto (XAUUSD pip 0.1)', () => {
    const { order } = buildOrderFromSummary('xauusd', plan('4165.57', '4159.57', '4177.57'));
    assert.deepEqual(order, { symbol: 'XAUUSD', side: 'LONG', entry: 4165.57, sl: 4156.57, tp: 4180.57 });
  });

  it('SHORT aleja SL hacia arriba y TP hacia abajo; 0 pips = niveles exactos', () => {
    const settings = { symbols: { us30: 'US30m' }, pipSize: { us30: 1 }, extraSlPips: 30, extraTpPips: 30 };
    const { order } = buildOrderFromSummary('us30', plan('51572', '51632', '51452'), settings);
    assert.equal(order.sl, 51662);
    assert.equal(order.tp, 51422);
    const exact = buildOrderFromSummary('us30', plan('51572', '51632', '51452'), { ...settings, extraSlPips: 0, extraTpPips: 0 });
    assert.equal(exact.order.sl, 51632);
    assert.equal(exact.order.tp, 51452);
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

  it('anyVerdict ejecuta el plan aunque el veredicto no sea ENTRAR (Run operation)', () => {
    const summary = { ...plan('51677', '51617', '51797'), verdict: 'NO_OPERAR' };
    const { order } = buildOrderFromSummary('us30', summary, { symbols: { us30: 'US30m' } }, { anyVerdict: true });
    assert.deepEqual(order, { symbol: 'US30m', side: 'LONG', entry: 51677, sl: 51617, tp: 51797 });
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

describe('reconcileOrder (Recalcular)', () => {
  const sent = { price: 50628.4, sl: 50566.3, tp: 50752.8, volume: 0.92 };

  it('detecta Entrada/SL/TP movidos en MT5 (orden pendiente real #679754928)', () => {
    const r = reconcileOrder(sent, { state: 'pending', entry: 50682.4, sl: 50590.6, tp: 50843.6, volume: 0.92 });
    assert.equal(r.changes.length, 3);
    assert.deepEqual(r.levels, { entry: 50682.4, sl: 50590.6, tp: 50843.6 });
    assert.equal(r.annotation, null);
    assert.equal(r.sentPatch.state, 'pending');
    assert.match(r.message, /reajustada/);
    assert.deepEqual(r.sentPatch.original, { price: 50628.4, sl: 50566.3, tp: 50752.8, volume: 0.92 });
    assert.equal(r.sentPatch.lastChanges.length, 3);
    const again = reconcileOrder({ ...sent, ...r.sentPatch }, { state: 'pending', entry: 50682.4, sl: 50511.9, tp: 50915.7, volume: 0.92 });
    assert.deepEqual(again.sentPatch.original, r.sentPatch.original);
  });

  it('cerrada → resultado y PnL; cancelada/expirada → no tomada', () => {
    const won = reconcileOrder(sent, { state: 'closed', entry: 50628.4, sl: 50566.3, tp: 50752.8, profit: 114.08 });
    assert.deepEqual(won.annotation, { resultado: 'ganada', pnlUsd: 114.08 });
    assert.equal(won.changes.length, 0);
    const lost = reconcileOrder(sent, { state: 'closed', profit: -57.2 });
    assert.equal(lost.annotation.resultado, 'perdida');
    assert.deepEqual(reconcileOrder(sent, { state: 'expired' }).annotation, { resultado: 'no_tomada' });
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
