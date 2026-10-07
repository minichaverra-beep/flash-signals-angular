/**
 * Tests de volatilidad: niveles por VIX, multiplicador de SL/TP, ATR y calculadora.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  applyVolatilityToStops,
  atrFromCandles,
  calculatePlan,
  classifyVix,
  levelMultiplier,
  resolveVolatilityAdjustment,
  thresholdsError,
} = require('./volatility');

describe('classifyVix', () => {
  it('Baja < 15 · Normal 15–20 · Alta 20–30 · Extrema > 30', () => {
    assert.equal(classifyVix(10), 'baja');
    assert.equal(classifyVix(14.99), 'baja');
    assert.equal(classifyVix(15), 'normal');
    assert.equal(classifyVix(19.99), 'normal');
    assert.equal(classifyVix(20), 'alta');
    assert.equal(classifyVix(30), 'alta');
    assert.equal(classifyVix(30.01), 'extrema');
    assert.equal(classifyVix(80), 'extrema');
  });

  it('respeta umbrales personalizados del perfil', () => {
    const s = { vixLowMax: 12, vixNormalMax: 18, vixHighMax: 25 };
    assert.equal(classifyVix(13, s), 'normal');
    assert.equal(classifyVix(18, s), 'alta');
    assert.equal(classifyVix(26, s), 'extrema');
  });

  it('puntos inválidos → null', () => {
    for (const bad of [null, undefined, '', 'abc', 0, -3, NaN]) assert.equal(classifyVix(bad), null);
  });
});

describe('levelMultiplier', () => {
  it('multiplicadores por defecto 0,8 / 1 / 1,3 / 1,6', () => {
    assert.deepEqual(['baja', 'normal', 'alta', 'extrema'].map((l) => levelMultiplier(l)), [0.8, 1, 1.3, 1.6]);
  });

  it('usa los del perfil y cae a 1 con nivel desconocido o valor inválido', () => {
    assert.equal(levelMultiplier('alta', { vixMultHigh: 1.5 }), 1.5);
    assert.equal(levelMultiplier(null), 1);
    assert.equal(levelMultiplier('alta', { vixMultHigh: 0 }), 1);
  });
});

describe('thresholdsError', () => {
  it('exige baja < normal < alta', () => {
    assert.equal(thresholdsError({}), null);
    assert.match(thresholdsError({ vixLowMax: 25 }), /baja < normal < alta/);
    assert.match(thresholdsError({ vixNormalMax: 15 }), /baja < normal < alta/);
  });
});

describe('applyVolatilityToStops', () => {
  it('LONG: multiplica las distancias y conserva SL < entry < TP', () => {
    const out = applyVolatilityToStops({ entry: 100, side: 'LONG', sl: 98, tp: 104, multiplier: 1.3 });
    assert.deepEqual(out, { sl: 97.4, tp: 105.2 });
  });

  it('SHORT: multiplica las distancias y conserva TP < entry < SL', () => {
    const out = applyVolatilityToStops({ entry: 100, side: 'SHORT', sl: 102, tp: 96, multiplier: 0.8 });
    assert.deepEqual(out, { sl: 101.6, tp: 96.8 });
  });

  it('multiplicador 1 o inválido no toca nada', () => {
    const args = { entry: 100, side: 'LONG', sl: 98, tp: 104 };
    for (const multiplier of [1, undefined, null, 0, -2, NaN]) {
      assert.deepEqual(applyVolatilityToStops({ ...args, multiplier }), { sl: 98, tp: 104 });
    }
  });

  it('coherencia con cualquier multiplicador válido (0,2–4)', () => {
    for (const multiplier of [0.2, 0.5, 0.8, 1.3, 1.6, 2.5, 4]) {
      const long = applyVolatilityToStops({ entry: 51000, side: 'LONG', sl: 50900, tp: 51200, multiplier });
      assert.ok(long.sl < 51000 && 51000 < long.tp, `LONG ×${multiplier}`);
      const short = applyVolatilityToStops({ entry: 51000, side: 'SHORT', sl: 51100, tp: 50800, multiplier });
      assert.ok(short.tp < 51000 && 51000 < short.sl, `SHORT ×${multiplier}`);
    }
  });
});

describe('resolveVolatilityAdjustment', () => {
  const on = { volatilityAdjustEnabled: true };

  it('toggle apagado → null (no se consulta ni se muestra nada)', () => {
    assert.equal(resolveVolatilityAdjustment({ volatilityAdjustEnabled: false }, { points: 40 }), null);
    assert.equal(resolveVolatilityAdjustment({}, null), null);
  });

  it('con dato: nivel, multiplicador y nota en español', () => {
    const r = resolveVolatilityAdjustment(on, { points: 24.3, source: 'yahoo', asOf: '2026-10-07T15:00:00.000Z' });
    assert.equal(r.level, 'alta');
    assert.equal(r.multiplier, 1.3);
    assert.equal(r.applied, true);
    assert.equal(r.source, 'yahoo');
    assert.equal(r.note, 'VIX 24,3 (alta) · SL/TP ×1,3 (se ensanchan)');
  });

  it('VIX normal: ×1 sin cambio', () => {
    const r = resolveVolatilityAdjustment(on, { points: 17 });
    assert.equal(r.applied, false);
    assert.match(r.note, /×1 \(sin cambio\)/);
  });

  it('sin dato: ×1, aviso y motivo', () => {
    const r = resolveVolatilityAdjustment(on, { error: 'Yahoo Finance: tiempo de espera agotado' });
    assert.equal(r.multiplier, 1);
    assert.equal(r.level, null);
    assert.match(r.note, /No se pudo leer el VIX: Yahoo Finance/);
  });
});

describe('atrFromCandles', () => {
  const flat = (n, range = 2) =>
    Array.from({ length: n }, () => ({ high: 100 + range / 2, low: 100 - range / 2, close: 100 }));

  it('ATR de velas con rango constante = ese rango (descarta la última, aún abierta)', () => {
    assert.equal(atrFromCandles(flat(40, 2)), 2);
    const withOpen = [...flat(40, 2), { high: 500, low: 1, close: 250 }];
    assert.equal(atrFromCandles(withOpen), 2);
  });

  it('incluye los huecos entre velas (gap) en el rango verdadero', () => {
    const candles = flat(30, 2);
    candles[20] = { high: 111, low: 109, close: 110 };
    assert.ok(atrFromCandles(candles) > 2);
  });

  it('sin velas suficientes → null', () => {
    assert.equal(atrFromCandles(flat(10)), null);
    assert.equal(atrFromCandles([]), null);
    assert.equal(atrFromCandles(undefined), null);
  });
});

describe('calculatePlan (calculadora)', () => {
  const btc = { tickSize: 0.01, tickValue: 0.01, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01, digits: 2 };
  const xau = { tickSize: 0.001, tickValue: 0.1, volumeMin: 0.01, volumeMax: 200, volumeStep: 0.01, digits: 3 };

  it('BTC: SL = 2 × movimiento típico, TP el doble, lotes por riesgo', () => {
    const plan = calculatePlan({ atr: 80, multiplier: 1, riskPct: 1, balance: 1000, pipSize: 1, symbol: btc });
    assert.equal(plan.slDistance, 160);
    assert.equal(plan.tpDistance, 320);
    assert.equal(plan.slPips, 160);
    assert.equal(plan.tpPips, 320);
    // arriesga 10 $ → 10 / 160 = 0,0625 lotes → 0,06 (hacia abajo)
    assert.equal(plan.lots, 0.06);
    assert.equal(plan.riskAmount, 9.6);
    assert.equal(plan.rewardAmount, 19.2);
    assert.equal(plan.realRiskPct, 0.96);
    assert.equal(plan.lotNote, null);
    assert.equal(plan.extraSlPips, 80);
    assert.equal(plan.extraTpPips, 160);
  });

  it('el multiplicador de volatilidad escala SL, TP y margen extra', () => {
    const calm = calculatePlan({ atr: 80, multiplier: 0.8, riskPct: 1, balance: 1000, pipSize: 1, symbol: btc });
    const wild = calculatePlan({ atr: 80, multiplier: 1.6, riskPct: 1, balance: 1000, pipSize: 1, symbol: btc });
    assert.equal(calm.slDistance, 128);
    assert.equal(wild.slDistance, 256);
    assert.equal(wild.tpDistance, 512);
    assert.ok(wild.lots < calm.lots);
    assert.equal(wild.extraSlPips, 128);
  });

  it('XAUUSD (pip 0,1): usa tick_value/tick_size y avisa si cae al lote mínimo', () => {
    const plan = calculatePlan({ atr: 1.5, multiplier: 1.3, riskPct: 1, balance: 190.69, pipSize: 0.1, symbol: xau });
    assert.equal(plan.slDistance, 3.9);
    assert.equal(plan.slPips, 39);
    assert.equal(plan.lots, 0.01);
    assert.equal(plan.riskAmount, 3.9);
    assert.match(plan.lotNote, /lote mínimo/);
    assert.ok(plan.realRiskPct > 1);
  });

  it('el beneficio es el doble que el riesgo (relación 1:2)', () => {
    const plan = calculatePlan({ atr: 25, multiplier: 1, riskPct: 0.5, balance: 5000, pipSize: 1, symbol: { ...btc, tickSize: 0.1, tickValue: 0.1, digits: 1 } });
    assert.equal(plan.rewardAmount, Math.round(plan.riskAmount * 2 * 100) / 100);
  });

  it('entradas inválidas lanzan 400', () => {
    const ok = { atr: 80, multiplier: 1, riskPct: 1, balance: 1000, pipSize: 1, symbol: btc };
    for (const patch of [{ atr: 0 }, { multiplier: 0 }, { riskPct: 0 }, { riskPct: 101 }, { balance: 0 }, { pipSize: 0 }, { symbol: { ...btc, tickValue: 0 } }]) {
      assert.throws(() => calculatePlan({ ...ok, ...patch }), (err) => err.status === 400);
    }
  });
});
