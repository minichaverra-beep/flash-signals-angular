/**
 * Specs del panel «Motor (Cursor Trading)»: node --experimental-strip-types --test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineSignal, SignalSummary } from '../services/signals-api.service';
import { engineBarLevel, enginePanel } from './engine-panel.helpers.ts';

const engine = (): EngineSignal => ({
  schemaVersion: 1,
  asset: 'BTC',
  signalId: 'btc-103',
  probability: { pct: 44.6, ci: [42.5, 46.5], evR: 0.137, kellyFrac: 0.01, calibrated: true, hasEdge: true, n: 2097, nEff: 755 },
  fusion: {
    score: 58.2,
    weights: { rules_e1: 0.4, rules_ext: 0.2, crt: 0.2, ml: 0.2 },
    layers: { rules: 83, extended: 80, crt: 100, neural: null, ml: 61, e2: null },
  },
  zentinel: { volume: { band: 'normal', ratio: 1.47 }, killzone: 'NY AM 08-10', killzoneOn: true },
  macdQuant: { available: true, soft_filter_ok: false, timeframe: 'H4', signal: -1, histogram: -288.87 },
  ict: { refined: true, source: 'FVG BEARISH edge', summary: '80152.9->80208.4' },
  crt: { h1_state: 'COMPLETED_BEAR', pd_reading: 'BEARISH', premium_discount: 'DISCOUNT', fakeout_pdh: false },
  contingencies: ['Si entraste: BE en 1:1', 'Cerrar si CRT invalid'],
  dataFreshness: { stale: true, message: 'Última vela hace 3 h' },
});

describe('enginePanel', () => {
  it('con JSON del motor: probabilidad, capas, filtros y contingencias', () => {
    const v = enginePanel({ engine: engine() } as SignalSummary);
    assert.ok(v);
    assert.equal(v.fromJson, true);
    assert.equal(v.signalId, 'btc-103');
    assert.deepEqual(
      [v.probability?.pct, v.probability?.ci, v.probability?.evR, v.probability?.kellyPct, v.probability?.badge, v.probability?.tone],
      [44.6, '43–47%', 0.137, 1, 'Calibrada', 'ok']
    );
    assert.equal(v.probability?.sample, 'n=2097 · n_eff 755');
    assert.equal(v.fusionScore, 58.2);
    assert.deepEqual(v.layers.map((l) => [l.label, l.score, l.weightPct]), [
      ['Reglas E1', 83, 40],
      ['Reglas extendidas', 80, 20],
      ['CRT coherente', 100, 20],
      ['ML tabular', 61, 20],
    ]);
    assert.deepEqual(v.zentinel, { band: 'normal', ratio: 1.47, killzone: 'NY AM 08-10', kzOn: true });
    assert.deepEqual(v.macd, { filter: 'En contra', tone: 'warn', detail: 'H4 · cruce SELL · hist -288.87' });
    assert.deepEqual(v.ict, ['Entrada refinada: FVG BEARISH edge', '80152.9->80208.4']);
    assert.deepEqual(v.crt, ['H1 COMPLETED_BEAR', 'PD BEARISH', 'DISCOUNT']);
    assert.equal(v.staleMessage, 'Última vela hace 3 h');
    assert.equal(v.contingencies.length, 2);
  });

  it('tasa base sin ventaja → badge de aviso', () => {
    const e = engine();
    e.probability = { ...e.probability, hasEdge: false };
    assert.equal(enginePanel({ engine: e } as SignalSummary)?.probability?.badge, 'Tasa base (sin ventaja)');
  });

  it('fila sin JSON: usa el summary disponible', () => {
    const v = enginePanel({
      scoreCombined: 52,
      probCalibrated: false,
      volume: { band: 'muy_bajo', ratio: 0.2 },
      zentinel: { killzone: 'NY AM', kzOn: false },
      dataStale: true,
      staleMessage: 'Datos viejos',
    } as SignalSummary);
    assert.ok(v);
    assert.equal(v.fromJson, false);
    assert.deepEqual([v.probability?.pct, v.probability?.badge, v.probability?.ci], [52, 'Heurística', null]);
    assert.deepEqual(v.layers, []);
    assert.equal(v.zentinel?.band, 'muy_bajo');
    assert.equal(v.macd, null);
    assert.equal(v.staleMessage, 'Datos viejos');
  });

  it('nada que mostrar → null; schema desconocido se ignora', () => {
    assert.equal(enginePanel(null), null);
    assert.equal(enginePanel({} as SignalSummary), null);
    assert.equal(enginePanel({ engine: { schemaVersion: 2, asset: 'BTC' } } as SignalSummary), null);
  });

  it('engineBarLevel', () => {
    assert.equal(engineBarLevel(80), 'high');
    assert.equal(engineBarLevel(50), 'mid');
    assert.equal(engineBarLevel(null), 'lo');
  });
});
