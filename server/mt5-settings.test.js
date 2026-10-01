/**
 * Tests de configuración MT5: validación, persistencia y ocultación del token.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const settings = require('./mt5-settings');

describe('mt5-settings', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt5-settings-'));
    process.env.MT5_SETTINGS_PATH = path.join(dir, 'mt5-settings.json');
  });

  after(() => {
    delete process.env.MT5_SETTINGS_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(process.env.MT5_SETTINGS_PATH, { force: true });
    settings._resetForTests();
  });

  it('sin archivo usa los defaults', () => {
    assert.equal(settings.get().symbols.xauusd, 'XAUUSD');
    assert.equal(settings.get().riskPct, 0.5);
  });

  it('persiste un patch parcial y lo recarga', () => {
    settings.update({ symbols: { us30: 'US30.cash' }, riskPct: 1, volume: null, expiryMinutes: 0 });
    settings._resetForTests();
    const s = settings.get();
    assert.equal(s.symbols.us30, 'US30.cash');
    assert.equal(s.symbols.btc, 'BTCUSD');
    assert.equal(s.riskPct, 1);
    assert.equal(s.expiryMinutes, 0);
  });

  it('rechaza valores fuera de rango sin guardar nada', () => {
    assert.throws(
      () => settings.update({ riskPct: 9, symbols: { btc: 'BTC USD' }, bridgeUrl: 'http://10.0.0.5:8765' }),
      (err) => err.status === 400 && err.errors.length === 3
    );
    assert.equal(fs.existsSync(process.env.MT5_SETTINGS_PATH), false);
  });

  it('nunca expone el token', () => {
    settings.update({ bridgeToken: 'secreto' });
    const pub = settings.toPublic();
    assert.equal(pub.hasToken, true);
    assert.equal('bridgeToken' in pub, false);
    assert.equal('bridgeToken' in settings.publicState().profiles.principal, false);
  });

  it('perfiles independientes y el activo decide qué se usa', () => {
    settings.update({ symbols: { xauusd: 'GOLD' }, bridgeUrl: 'http://127.0.0.1:8766' }, 'secundaria');
    assert.equal(settings.getActive(), 'principal');
    assert.equal(settings.get().symbols.xauusd, 'XAUUSD');

    settings.setActive('secundaria');
    settings._resetForTests();
    assert.equal(settings.getActive(), 'secundaria');
    assert.equal(settings.get().symbols.xauusd, 'GOLD');
    assert.equal(settings.get().bridgeUrl, 'http://127.0.0.1:8766');
    assert.equal(settings.get('principal').bridgeUrl, 'http://127.0.0.1:8765');
    assert.throws(() => settings.setActive('otra'), (err) => err.status === 400);
  });

  it('migra el formato antiguo (plano) a Conf principal', () => {
    fs.writeFileSync(process.env.MT5_SETTINGS_PATH, JSON.stringify({ riskPct: 2, symbols: { us30: 'DJ30' } }));
    settings._resetForTests();
    assert.equal(settings.getActive(), 'principal');
    assert.equal(settings.get('principal').riskPct, 2);
    assert.equal(settings.get('principal').symbols.us30, 'DJ30');
    assert.equal(settings.get('secundaria').riskPct, 0.5);
  });
});
