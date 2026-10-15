/**
 * Tests de resultados reales → Cursor Trading (live/outcomes/<asset>_outcomes.jsonl).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  outcomesFile,
  buildOutcomeRecord,
  recordOutcome,
} = require('./engine-outcomes');

const silent = { warn: () => {} };
const NOW = new Date('2026-10-15T14:00:00Z');

const row = (over = {}) => ({
  id: 7,
  market: 'btc',
  finishedAt: '2026-10-15T13:56:30Z',
  resultado: 'ganada',
  pnlUsd: 18.5,
  pnlSource: null,
  effectiveLocked: false,
  real: null,
  summary: {
    verdict: 'ENTRAR',
    scoreCombined: 52,
    mlPct: null,
    planDetails: { entry: '80208.4', sl: '80440.5', tp: '79744.2' },
    engine: {
      schemaVersion: 1,
      signalId: 'btc-103',
      generatedUtc: '2026-10-15T13:56:00Z',
      direction: 'SHORT',
      probability: { pct: 44.6, ci: [42.5, 46.5], evR: 0.137, calibrated: true },
      fusion: { score: null },
      rules: { e1: { pct: 83 } },
      ml: { pct: 61 },
      neural: { pct: 70, effectivePct: 58 },
    },
  },
  ...over,
});

const readLines = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('buildOutcomeRecord', () => {
  it('schema 1 con predicción del motor y plan', () => {
    const sent = { order: 555, price: 80210, sl: 80440, tp: 79744, volume: 0.02, closeReason: 'tp', duplicate: { order: 556, volume: 0.02, state: 'closed' } };
    const rec = buildOutcomeRecord(row(), { source: 'mt5_recalc', sent, profile: 'demo', now: NOW });
    assert.equal(rec.schemaVersion, 1);
    assert.equal(rec.recordedUtc, '2026-10-15T14:00:00.000Z');
    assert.equal(rec.historyId, 7);
    assert.equal(rec.signalId, 'btc-103');
    assert.equal(rec.asset, 'BTC');
    assert.equal(rec.direction, 'SHORT');
    assert.deepEqual(rec.plan, { entry: 80208.4, sl: 80440.5, tp: 79744.2 });
    assert.equal(rec.prediction.probabilityPct, 44.6);
    assert.deepEqual(rec.prediction.ci, [42.5, 46.5]);
    assert.equal(rec.prediction.mlPct, 61);
    assert.equal(rec.prediction.neuralPct, 58);
    assert.equal(rec.prediction.rulesPct, 83);
    assert.equal(rec.prediction.fusionScore, 52);
    assert.equal(rec.outcome.resultado, 'ganada');
    assert.equal(rec.outcome.pnlUsd, 18.5);
    assert.equal(rec.outcome.closeReason, 'tp');
    assert.deepEqual(rec.outcome.mt5, { ticket: 555, entry: 80210, sl: 80440, tp: 79744, exit: null, volume: 0.02, profile: 'demo' });
    assert.equal(rec.outcome.duplicate.ticket, 556);
    assert.equal(rec.source, 'mt5_recalc');
  });

  it('fila sin JSON del motor → usa summary (scoreCombined)', () => {
    const r = row({ summary: { verdict: 'ESPERAR', scoreCombined: 40, planDetails: {} } });
    const rec = buildOutcomeRecord(r, { source: 'manual', now: NOW });
    assert.equal(rec.signalId, null);
    assert.equal(rec.prediction.probabilityPct, 40);
    assert.equal(rec.outcome.mt5, null);
    assert.equal(rec.generatedUtc, '2026-10-15T13:56:30Z');
  });
});

describe('recordOutcome', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-outcomes-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('escribe una vez; idempotente si no cambia', () => {
    const a = recordOutcome({ tradingRoot: root, row: row(), source: 'manual', logger: silent, now: NOW });
    assert.equal(a.written, true);
    assert.equal(a.file, outcomesFile(root, 'btc'));
    const b = recordOutcome({ tradingRoot: root, row: row(), source: 'auto_capture', logger: silent, now: NOW });
    assert.deepEqual([b.written, b.reason], [false, 'unchanged']);
    assert.equal(readLines(a.file).length, 1);
  });

  it('si cambia el resultado añade revision 2 con supersedes', () => {
    recordOutcome({ tradingRoot: root, row: row(), source: 'manual', logger: silent, now: NOW });
    const c = recordOutcome({ tradingRoot: root, row: row({ resultado: 'perdida', pnlUsd: -9 }), source: 'manual', logger: silent, now: NOW });
    assert.equal(c.written, true);
    const lines = readLines(c.file);
    assert.equal(lines.length, 2);
    assert.deepEqual([lines[1].revision, lines[1].supersedes, lines[1].outcome.resultado], [2, 1, 'perdida']);
  });

  it('nunca para operando / vacío / bloqueada / mercado sin pipeline', () => {
    for (const [r, reason] of [
      [row({ resultado: 'operando' }), 'not_final'],
      [row({ resultado: null }), 'not_final'],
      [row({ effectiveLocked: true }), 'locked'],
      [row({ market: 'ukoil' }), 'market'],
    ]) {
      const out = recordOutcome({ tradingRoot: root, row: r, source: 'manual', logger: silent });
      assert.deepEqual([out.written, out.reason], [false, reason]);
    }
    assert.equal(fs.existsSync(path.join(root, 'live', 'outcomes')), false);
  });

  it('sin CURSOR_TRADING_ROOT o no escribible → aviso, sin lanzar', () => {
    const warnings = [];
    const logger = { warn: (m) => warnings.push(m) };
    const missing = recordOutcome({ tradingRoot: path.join(root, 'nope'), row: row(), source: 'manual', logger });
    assert.equal(missing.reason, 'no_root');
    const brokenFs = { ...fs, existsSync: () => true, readFileSync: () => '', mkdirSync: () => {}, appendFileSync: () => { throw new Error('EACCES'); } };
    const failed = recordOutcome({ tradingRoot: root, row: row(), source: 'manual', logger, fsImpl: brokenFs });
    assert.equal(failed.reason, 'io_error');
    assert.equal(warnings.length, 2);
  });
});
