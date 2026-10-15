/**
 * Tests del JSON del motor (Cursor Trading schema 1): lectura, validación, mapper y fallback al .md.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ENGINE_MAX_LAG_MS,
  engineJsonPath,
  loadEngineJson,
  summaryFromEngine,
  mergeEngineSummary,
  rrText,
} = require('./engine-signal');

const sampleEngine = () => ({
  schemaVersion: 1,
  asset: 'BTC',
  mode: 'high',
  generatedUtc: '2026-10-15T13:56:00Z',
  signalId: 'btc-103',
  verdict: 'ENTRAR',
  direction: 'SHORT',
  price: 80152.87,
  bias: 'AUTO',
  setup: 'AUTO',
  winrate: { value: '~45%', source: 'calibrado' },
  plan: {
    entry: 80208.38, optimalEntry: 80208.38, sl: 80440.484, tp: 79744.172, rr: 2, risk: 232.104,
    trigger: 'ICT retest', invalidation: 'Cierre M5 > 80385', confirmation: '2 velas rojas',
  },
  probability: { pct: 44.6, ci: [42.5, 46.5], evR: 0.137, kellyFrac: 0.01, calibrated: true, method: 'walk_forward_logistic' },
  fusion: { score: null, weights: null, layers: { rules: 83, extended: 80, crt: 100, neural: null, ml: null, e2: 33.3 } },
  confluence: { pct: 69, label: 'MEDIA' },
  rules: { e1: { ok: 5, total: 6, pct: 83 }, extended: { pct: 80 } },
  ml: null,
  neural: null,
  zentinel: {
    volume: { band: 'normal', ratio: 1.4687, preset_name: 'Zentinel_BTC_E1' },
    killzone: 'NY AM 08-10',
    killzoneOn: true,
  },
  redFlags: ['Precio < PDL'],
  checklists: {
    e1: [{ label: 'Solo E1', ok: true, note: 'Operar solo E1' }],
    rulesReview: [{ label: 'RSI', grade: '✓', value: 'RSI 38', impact: '+8 pts', wr: '55%', type: 'ponderada' }],
  },
  dataFreshness: { stale: false, message: null, lastCandleUtc: '2026-10-15 13:55' },
});

const mdSummary = () => ({
  market: 'btc',
  tier: 'high',
  verdict: 'ENTRAR',
  scoreCombined: 52,
  rulesPct: 80,
  confluencePct: 60,
  planDetails: { entry: '80208.4', sl: '80440.5', tp: '79744.2', rr: '1:2', risk: '232.1', trigger: 'md trigger', invalidation: null, confirmation: null },
  redFlags: [],
  checklistE1: [],
  rulesReview: [],
  chartScores: [{ label: 'Rules E1', value: 80 }],
  volume: { band: 'muy_bajo', ratio: 0.1, preset: 'Zentinel_BTC_E1', thresholds: { very_low: 0.45, low: 0.75, high: 1.7, extreme: 2.6 } },
  zentinel: { killzone: 'md kz', watchtowerKz: 'NY AM', volBand: 'muy_bajo', volRatio: 0.1, kzOn: false, note: 'n' },
});

describe('engineJsonPath', () => {
  it('solo para reportes High', () => {
    assert.equal(engineJsonPath('C:/x/live/btc_m5_high_signal.md'), 'C:/x/live/btc_m5_high_signal.json');
    assert.equal(engineJsonPath('C:/x/live/btc_m5_signal.md'), null);
    assert.equal(engineJsonPath(null), null);
  });
});

describe('loadEngineJson', () => {
  let dir;
  let md;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-json-'));
    md = path.join(dir, 'btc_m5_high_signal.md');
    fs.writeFileSync(md, '# report');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const json = () => path.join(dir, 'btc_m5_high_signal.json');
  const mdMtime = () => fs.statSync(md).mtimeMs;

  it('missing → fallback', () => {
    assert.deepEqual(loadEngineJson(md, mdMtime()), { engine: null, reason: 'missing' });
  });

  it('JSON inválido → fallback', () => {
    fs.writeFileSync(json(), '{roto');
    assert.equal(loadEngineJson(md, mdMtime()).reason, 'invalid');
  });

  it('otra versión de schema → fallback', () => {
    fs.writeFileSync(json(), JSON.stringify({ ...sampleEngine(), schemaVersion: 0 }));
    assert.equal(loadEngineJson(md, mdMtime()).reason, 'schema');
  });

  it('JSON de una corrida anterior al .md → stale', () => {
    fs.writeFileSync(json(), JSON.stringify(sampleEngine()));
    const old = new Date(mdMtime() - ENGINE_MAX_LAG_MS - 60_000);
    fs.utimesSync(json(), old, old);
    assert.equal(loadEngineJson(md, mdMtime()).reason, 'stale');
  });

  it('válido y fresco → engine', () => {
    fs.writeFileSync(json(), JSON.stringify(sampleEngine()));
    const out = loadEngineJson(md, mdMtime());
    assert.equal(out.reason, 'ok');
    assert.equal(out.engine.signalId, 'btc-103');
  });
});

describe('summaryFromEngine (sin .md)', () => {
  it('mapea al shape del summary', () => {
    const s = summaryFromEngine(sampleEngine(), 'btc', 'high');
    assert.equal(s.verdict, 'ENTRAR');
    assert.equal(s.price, '80152.87');
    assert.deepEqual(s.planDetails, {
      entry: '80208.38', sl: '80440.48', tp: '79744.17', rr: '1:2', risk: '232.1',
      trigger: 'ICT retest', invalidation: 'Cierre M5 > 80385', confirmation: '2 velas rojas',
    });
    assert.equal(s.scoreCombined, 44.6);
    assert.equal(s.rulesPct, 83);
    assert.equal(s.confluenceLabel, 'MEDIA');
    assert.equal(s.probCalibrated, true);
    assert.equal(s.zentinel.kzOn, true);
    assert.equal(s.volume.band, 'normal');
    assert.equal(s.dataAsOf, '2026-10-15 13:55 UTC');
    assert.equal(s.checklistE1[0].label, 'Solo E1');
    assert.equal(s.rulesReview[0].winrate, '55%');
    assert.ok(s.chartScores.some((b) => b.label === 'Probabilidad de éxito' && b.value === 44.6));
    assert.equal(s.engine.schemaVersion, 1);
    assert.equal(s.engineSource, 'json');
  });

  it('rrText', () => {
    assert.equal(rrText(2), '1:2');
    assert.equal(rrText(1.75), '1:1.8');
    assert.equal(rrText(null), null);
  });
});

describe('mergeEngineSummary', () => {
  it('sin JSON → summary del .md intacto (fallback)', () => {
    const md = mdSummary();
    const out = mergeEngineSummary(md, null, 'btc', 'high');
    assert.deepEqual({ ...out, engineSource: undefined }, { ...md, engineSource: undefined });
    assert.equal(out.engineSource, 'markdown');
    assert.equal(mergeEngineSummary(null, null, 'btc', 'high'), null);
  });

  it('JSON prevalece en análisis; plan de órdenes, scoreCombined y verdict del .md se conservan', () => {
    const out = mergeEngineSummary(mdSummary(), sampleEngine(), 'btc', 'high');
    assert.deepEqual(
      [out.planDetails.entry, out.planDetails.sl, out.planDetails.tp, out.planDetails.rr],
      ['80208.4', '80440.5', '79744.2', '1:2']
    );
    assert.equal(out.planDetails.trigger, 'md trigger');
    assert.equal(out.planDetails.invalidation, 'Cierre M5 > 80385');
    assert.equal(out.scoreCombined, 52);
    assert.equal(out.verdict, 'ENTRAR');
    assert.equal(out.rulesPct, 83);
    assert.equal(out.confluencePct, 69);
    assert.equal(out.volume.band, 'normal');
    assert.deepEqual(out.volume.thresholds, mdSummary().volume.thresholds);
    assert.equal(out.zentinel.killzone, 'NY AM 08-10');
    assert.equal(out.zentinel.watchtowerKz, 'NY AM');
    assert.deepEqual(out.redFlags, ['Precio < PDL']);
    assert.equal(out.checklistE1.length, 1);
    assert.deepEqual(out.chartScores, [{ label: 'Rules E1', value: 80 }]);
    assert.equal(out.engine.signalId, 'btc-103');
    assert.equal(out.engineSource, 'json');
  });
});
