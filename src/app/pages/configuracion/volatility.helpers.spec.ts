import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageText,
  classifyVix,
  formatMoney,
  levelMultiplier,
  levelRangeText,
  riskRewardBar,
  thermometer,
} from './volatility.helpers.ts';

const T = { vixLowMax: 15, vixNormalMax: 20, vixHighMax: 30 };
const M = { vixMultLow: 0.8, vixMultNormal: 1, vixMultHigh: 1.3, vixMultExtreme: 1.6 };

describe('volatility.helpers (sección Volatilidad)', () => {
  it('classifyVix usa los umbrales del borrador (misma regla que el servidor)', () => {
    assert.equal(classifyVix(14.9, T), 'baja');
    assert.equal(classifyVix(15, T), 'normal');
    assert.equal(classifyVix(20, T), 'alta');
    assert.equal(classifyVix(30, T), 'alta');
    assert.equal(classifyVix(30.1, T), 'extrema');
    assert.equal(classifyVix(18, { ...T, vixNormalMax: 17 }), 'alta');
    assert.equal(classifyVix(null, T), null);
    assert.equal(classifyVix(0, T), null);
  });

  it('levelMultiplier por nivel y 1 si el valor no es válido', () => {
    assert.deepEqual((['baja', 'normal', 'alta', 'extrema'] as const).map((l) => levelMultiplier(l, M)), [0.8, 1, 1.3, 1.6]);
    assert.equal(levelMultiplier(null, M), 1);
    assert.equal(levelMultiplier('alta', { ...M, vixMultHigh: Number.NaN }), 1);
  });

  it('levelRangeText describe cada tramo en lenguaje llano', () => {
    assert.equal(levelRangeText('baja', T), 'Menos de 15');
    assert.equal(levelRangeText('normal', T), '15 a 20');
    assert.equal(levelRangeText('alta', T), '20 a 30');
    assert.equal(levelRangeText('extrema', T), 'Más de 30');
  });

  it('thermometer: zonas que suman 100 % y marcador dentro de la barra', () => {
    const t = thermometer(24, T);
    assert.equal(Math.round(t.zones.reduce((s, z) => s + z.widthPct, 0)), 100);
    assert.equal(t.zones.length, 4);
    assert.equal(t.markerPct, (24 / 45) * 100);
    assert.equal(thermometer(120, T).markerPct, 100);
    assert.equal(thermometer(null, T).markerPct, 0);
  });

  it('riskRewardBar reparte la barra y nunca deja un lado invisible', () => {
    assert.deepEqual(riskRewardBar(10, 20), { riskPct: (10 / 30) * 100, rewardPct: 100 - (10 / 30) * 100 });
    assert.equal(riskRewardBar(0.01, 1000).riskPct, 4);
    assert.deepEqual(riskRewardBar(0, 0), { riskPct: 50, rewardPct: 50 });
  });

  it('formatMoney usa coma decimal', () => {
    assert.equal(formatMoney(7.5), '7,50 $');
    assert.equal(formatMoney(15), '15 $');
    assert.equal(formatMoney(3, 'EUR'), '3 EUR');
  });

  it('ageText', () => {
    const now = Date.parse('2026-10-07T15:00:00.000Z');
    assert.equal(ageText('2026-10-07T14:57:00.000Z', now), 'hace 3 min');
    assert.equal(ageText('2026-10-07T12:00:00.000Z', now), 'hace 3 h');
    assert.equal(ageText('2026-10-07T14:59:50.000Z', now), 'hace unos segundos');
    assert.equal(ageText('x', now), '');
  });
});
