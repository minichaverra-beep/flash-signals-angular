/**
 * Tests del registro persistente de señales enviadas a MT5 (anti doble envío).
 */
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt5-sent-'));
process.env.MT5_SENT_PATH = path.join(dir, 'mt5-sent.json');
const sent = require('./mt5-sent');

describe('mt5-sent', () => {
  beforeEach(() => {
    fs.rmSync(process.env.MT5_SENT_PATH, { force: true });
    sent._resetForTests();
  });

  after(() => {
    delete process.env.MT5_SENT_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registra por perfil y sobrevive a un reinicio (recarga del archivo)', () => {
    sent.record('principal', 'h42', { symbol: 'XAUUSDm', side: 'LONG', mode: 'pending', order: 123, account: { login: 1 } });
    assert.equal(sent.has('principal', 'h42'), true);
    assert.equal(sent.has('secundaria', 'h42'), false);
    sent._resetForTests();
    assert.equal(sent.has('principal', 'h42'), true);
  });

  it('historyMap solo devuelve claves h<id> del perfil', () => {
    sent.record('principal', 'h7', { order: 1 });
    sent.record('principal', 'rxauusd1700000000', { order: 2 });
    sent.record('secundaria', 'h8', { order: 3 });
    const map = sent.historyMap('principal');
    assert.deepEqual(Object.keys(map), ['7']);
    assert.equal(map[7].order, 1);
  });

  it('entriesFor devuelve todos los envíos del perfil sin el prefijo', () => {
    sent.record('principal', 'h7', { order: 1 });
    sent.record('principal', 'rxauusd1700000000', { order: 2 });
    sent.record('secundaria', 'h8', { order: 3 });
    assert.deepEqual(Object.keys(sent.entriesFor('principal')).sort(), ['h7', 'rxauusd1700000000']);
  });
});
