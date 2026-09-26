/**
 * Tests for recalc-probabilidad (v2 blend + location).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeNewProbabilidad,
  recalcSummaryProbabilidad,
  RECALC_VERSION,
} = require('./recalc-probabilidad');

describe('recalc-probabilidad', () => {
  it('blends 73 with BAJA 38 → ~47 after PREMIUM break', () => {
    const r = computeNewProbabilidad(73, {
      direction: 'LONG',
      setupMode: 'break',
      premiumDiscount: 'PREMIUM',
      confluencePct: 38,
    });
    // 73 * 0.72 = 52.56; 0.62*52.56 + 0.38*38 ≈ 47.0
    assert.ok(r.scoreCombined < 55);
    assert.ok(r.scoreCombined > 40);
    assert.equal(r.locationMult, 0.72);
  });

  it('bonifica SHORT en PREMIUM (zona a favor)', () => {
    const r = computeNewProbabilidad(60, {
      direction: 'SHORT',
      setupMode: 'reverse',
      premiumDiscount: 'PREMIUM',
      confluencePct: null,
    });
    assert.equal(r.locationMult, 1.06);
    assert.ok(r.scoreCombined > 60);
  });

  it('is idempotent via scoreRecalcVersion', () => {
    const summary = {
      scoreCombined: 73,
      confluencePct: 38,
      bias: 'bullish',
      setup: 'BREAK',
    };
    const preview = 'Posición precio: **PREMIUM** (precio 84000)\nmodo **BREAK**';
    const first = recalcSummaryProbabilidad(summary, {
      preview,
      flags: { bullish: true },
    });
    assert.equal(first.changed, true);
    assert.equal(first.summary.scoreRecalcVersion, RECALC_VERSION);
    const second = recalcSummaryProbabilidad(first.summary, {
      preview,
      flags: { bullish: true },
    });
    assert.equal(second.changed, false);
    assert.equal(second.scoreCombined, first.scoreCombined);
  });

  it('tasa refleja SHORT en DISCOUNT y bias alineado', () => {
    const { computeNewWinrate } = require('./recalc-probabilidad');
    const wr = computeNewWinrate({
      rulesPct: 83,
      setupMode: 'reverse',
      direction: 'SHORT',
      premiumDiscount: 'DISCOUNT',
      confluenceLabel: 'BAJA',
      confluencePct: 38,
      biasH1: 'BEARISH',
      modeBias: 'bearish',
    });
    assert.ok(wr);
    assert.match(wr.winrateDisplay, /DISCOUNT/);
    assert.match(wr.winrateSource, /H1 BEARISH a favor/);
    assert.match(wr.winrateSource, /acuerdo BAJA/);
  });
});
