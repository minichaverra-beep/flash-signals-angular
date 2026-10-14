/**
 * Tests de la probabilidad mínima para Run operation.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { minProbabilityPct, rowProbability, probabilityRejection } = require('./mt5-probability');

describe('mt5-probability', () => {
  it('mínimo por defecto 45 y respeta el del perfil (0 = sin mínimo)', () => {
    assert.equal(minProbabilityPct({}), 45);
    assert.equal(minProbabilityPct({ minProbabilityPct: 60 }), 60);
    assert.equal(minProbabilityPct({ minProbabilityPct: 0 }), 0);
    assert.equal(minProbabilityPct({ minProbabilityPct: 'x' }), 45);
  });

  it('lee scoreCombined de la fila o del summary', () => {
    assert.equal(rowProbability({ scoreCombined: 57 }), 57);
    assert.equal(rowProbability({ summary: { scoreCombined: '38.5' } }), 38.5);
    assert.equal(rowProbability({ scoreCombined: null, summary: {} }), null);
    assert.equal(rowProbability(null), null);
  });

  it('bloquea si la probabilidad es menor que el mínimo', () => {
    const r = probabilityRejection({ scoreCombined: 38 }, { minProbabilityPct: 45 });
    assert.equal(r.blocked, true);
    assert.equal(r.message, 'Probabilidad 38% < mínimo 45%: Run bloqueado');
    assert.equal(probabilityRejection({ scoreCombined: 44.9 }, {}).blocked, true);
  });

  it('permite si la probabilidad es igual o mayor que el mínimo', () => {
    assert.equal(probabilityRejection({ scoreCombined: 45 }, {}).blocked, false);
    const r = probabilityRejection({ scoreCombined: 57 }, { minProbabilityPct: 45 });
    assert.deepEqual([r.blocked, r.message, r.warning], [false, null, null]);
  });

  it('mínimo 0: nunca bloquea ni avisa', () => {
    const r = probabilityRejection({ scoreCombined: 5 }, { minProbabilityPct: 0 });
    assert.deepEqual([r.blocked, r.warning], [false, null]);
    assert.equal(probabilityRejection({}, { minProbabilityPct: 0 }).warning, null);
  });

  it('probabilidad desconocida: permite con aviso', () => {
    const r = probabilityRejection({ scoreCombined: null }, {});
    assert.equal(r.blocked, false);
    assert.match(r.warning, /Probabilidad desconocida/);
  });
});
