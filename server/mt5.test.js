/**
 * Tests de mapeo señal → orden MT5 (sin puente ni terminal).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.MT5_SETTINGS_PATH = path.join(os.tmpdir(), `mt5-test-${process.pid}-missing.json`);
const { buildManualOrder, buildOrderFromSummary, reconcileOrder, symbolFor } = require('./mt5');
const { resolveVolatilityAdjustment } = require('./volatility');

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

  it('reversiones desactivadas por defecto: setup REVERSE no se envía salvo reversalsEnabled', () => {
    const summary = { ...plan('51677', '51617', '51797'), setup: 'REVERSE' };
    const settings = { symbols: { us30: 'US30m' } };
    assert.match(buildOrderFromSummary('us30', summary, settings).skip, /reversiones están desactivadas/);
    assert.equal(buildOrderFromSummary('us30', summary, { ...settings, reversalsEnabled: true }).order.side, 'LONG');
    assert.ok(buildOrderFromSummary('us30', { ...summary, setup: 'BREAK' }, settings).order);
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

describe('ajuste de SL/TP por volatilidad (VIX)', () => {
  const base = {
    symbols: { us30: 'US30m' },
    pipSize: { us30: 1 },
    extraSlPips: 0,
    extraTpPips: 0,
    vixLowMax: 15,
    vixNormalMax: 20,
    vixHighMax: 30,
    vixMultLow: 0.8,
    vixMultNormal: 1,
    vixMultHigh: 1.3,
    vixMultExtreme: 1.6,
  };
  const build = (settings, points, summary) => {
    const volatility = resolveVolatilityAdjustment(settings, points == null ? null : { points, source: 'yahoo' });
    return buildOrderFromSummary('us30', summary, settings, { volatility });
  };
  const long = plan('51000', '50900', '51200');
  const short = plan('51000', '51100', '50800');

  it('toggle apagado: niveles intactos y sin nota de volatilidad', () => {
    const off = { ...base, volatilityAdjustEnabled: false };
    const res = build(off, 35, long);
    assert.equal(res.volatility, null);
    assert.deepEqual(res.order, { symbol: 'US30m', side: 'LONG', entry: 51000, sl: 50900, tp: 51200 });
  });

  it('toggle activo LONG: VIX alto ensancha (×1,3) y mantiene SL < entry < TP', () => {
    const { order, volatility } = build({ ...base, volatilityAdjustEnabled: true }, 24, long);
    assert.equal(order.sl, 50870);
    assert.equal(order.tp, 51260);
    assert.ok(order.sl < order.entry && order.entry < order.tp);
    assert.equal(volatility.multiplier, 1.3);
    assert.equal(volatility.level, 'alta');
  });

  it('toggle activo SHORT: VIX bajo estrecha (×0,8) y mantiene TP < entry < SL', () => {
    const { order, volatility } = build({ ...base, volatilityAdjustEnabled: true }, 12, short);
    assert.equal(order.sl, 51080);
    assert.equal(order.tp, 50840);
    assert.ok(order.tp < order.entry && order.entry < order.sl);
    assert.match(volatility.note, /se estrechan/);
  });

  it('VIX normal no cambia nada (×1)', () => {
    const { order } = build({ ...base, volatilityAdjustEnabled: true }, 17, long);
    assert.equal(order.sl, 50900);
    assert.equal(order.tp, 51200);
  });

  it('el multiplicador escala las distancias de la señal y después se suma el margen extra en pips', () => {
    const settings = { ...base, volatilityAdjustEnabled: true, extraSlPips: 10, extraTpPips: 20 };
    const { order } = build(settings, 35, long);
    // extrema ×1,6: SL 160 pts, TP 320 pts; luego +10 / +20 pips (1 pip = 1)
    assert.equal(order.sl, 51000 - 160 - 10);
    assert.equal(order.tp, 51000 + 320 + 20);
  });

  it('sin dato de VIX la orden no se bloquea: ×1 y aviso', () => {
    const { order, volatility } = build({ ...base, volatilityAdjustEnabled: true }, null, long);
    assert.equal(order.sl, 50900);
    assert.equal(order.tp, 51200);
    assert.equal(volatility.multiplier, 1);
    assert.equal(volatility.level, null);
    assert.match(volatility.note, /No se pudo leer el VIX/);
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

  it('cerrada → guarda precio y horas reales de cierre (UTC) para el gráfico de resultado', () => {
    const r = reconcileOrder(sent, {
      state: 'closed', profit: -2.42, closePrice: 83069.38, openTime: 1791381039, closeTime: 1791381697,
    });
    assert.equal(r.sentPatch.closePrice, 83069.38);
    assert.equal(r.sentPatch.openTime, '2026-10-07T13:50:39.000Z');
    assert.equal(r.sentPatch.closeTime, '2026-10-07T14:01:37.000Z');
    const oldBridge = reconcileOrder({ ...sent, ...r.sentPatch }, { state: 'closed', profit: -2.42 });
    assert.equal(oldBridge.sentPatch.closeTime, '2026-10-07T14:01:37.000Z');
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

describe('brokerFeedEnv', () => {
  const { brokerFeedEnv } = require('./mt5');

  it('pasa puente, token y símbolos del perfil a los scripts de análisis', () => {
    const env = brokerFeedEnv({
      bridgeUrl: 'http://127.0.0.1:8765',
      bridgeToken: 'secreto',
      symbols: { us30: 'US30m', xauusd: 'XAUUSDm', btc: 'BTCUSDm' },
    });
    assert.deepEqual(env, {
      FS_MT5_BRIDGE_URL: 'http://127.0.0.1:8765',
      FS_MT5_BRIDGE_TOKEN: 'secreto',
      FS_MT5_SYMBOL_US30: 'US30m',
      FS_MT5_SYMBOL_XAUUSD: 'XAUUSDm',
      FS_MT5_SYMBOL_BTC: 'BTCUSDm',
    });
  });

  it('sin token ni símbolo no inventa variables', () => {
    const env = brokerFeedEnv({ bridgeUrl: 'http://127.0.0.1:8766', symbols: { us30: 'US30' } });
    assert.deepEqual(env, { FS_MT5_BRIDGE_URL: 'http://127.0.0.1:8766', FS_MT5_SYMBOL_US30: 'US30' });
  });
});
