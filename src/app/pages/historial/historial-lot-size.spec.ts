import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recommendedLot } from './historial-lot-size.ts';

describe('historial-lot-size (lote recomendado en móvil)', () => {
  it('BTC: 1 % de 1000 $ con SL a 160 puntos → 0,06 lotes (hacia abajo), como calculatePlan', () => {
    const r = recommendedLot({ market: 'btc', entry: 60_000, sl: 59_840, balance: 1000, riskPct: 1 });
    assert.deepEqual(r, { lots: 0.06, riskUsd: 10, realRiskUsd: 9.6, belowMin: false });
  });

  it('XAUUSD: 100 USD por 1,0 de precio; venta con SL por encima', () => {
    const r = recommendedLot({ market: 'XAUUSD', entry: 2400, sl: 2405, balance: 10_000, riskPct: 1 });
    // 100 $ / (5 × 100) = 0,2 lotes
    assert.equal(r?.lots, 0.2);
    assert.equal(r?.realRiskUsd, 100);
  });

  it('bajo el lote mínimo usa 0,01 y avisa del riesgo real', () => {
    const r = recommendedLot({ market: 'xauusd', entry: 2400, sl: 2396.1, balance: 190.69, riskPct: 1 });
    assert.equal(r?.lots, 0.01);
    assert.equal(r?.belowMin, true);
    assert.equal(r?.realRiskUsd, 3.9);
    assert.ok(r!.realRiskUsd > r!.riskUsd);
  });

  it('acota al lote máximo', () => {
    assert.equal(recommendedLot({ market: 'us30', entry: 40_000, sl: 39_999, balance: 1e7, riskPct: 5 })?.lots, 200);
  });

  it('sin datos suficientes devuelve null', () => {
    const ok = { market: 'btc', entry: 60_000, sl: 59_000, balance: 1000, riskPct: 1 };
    for (const patch of [{ market: 'eurusd' }, { entry: null }, { sl: undefined }, { sl: 60_000 }, { balance: null }, { balance: 0 }, { riskPct: 0 }]) {
      assert.equal(recommendedLot({ ...ok, ...patch }), null, JSON.stringify(patch));
    }
  });
});
