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

  it('balance de la cuenta: null por defecto, > 0 al guardar y "" lo borra', () => {
    assert.equal(settings.get().accountBalance, null);
    settings.update({ accountBalance: 5000 });
    settings._resetForTests();
    assert.equal(settings.get().accountBalance, 5000);
    assert.throws(() => settings.update({ accountBalance: 0 }), (err) => err.status === 400);
    assert.throws(() => settings.update({ accountBalance: -10 }), (err) => err.status === 400);
    settings.update({ accountBalance: '' });
    assert.equal(settings.get().accountBalance, null);
  });

  it('límite diario de operaciones: activo por defecto con 6, toggle y rango 1–100', () => {
    assert.equal(settings.get().dailyTradeLimitEnabled, true);
    assert.equal(settings.get().maxTradesPerDay, 6);
    settings.update({ dailyTradeLimitEnabled: false, maxTradesPerDay: 4 });
    settings._resetForTests();
    assert.equal(settings.get().dailyTradeLimitEnabled, false);
    assert.equal(settings.get().maxTradesPerDay, 4);
    assert.throws(() => settings.update({ maxTradesPerDay: 0 }), (err) => err.status === 400);
    assert.throws(() => settings.update({ maxTradesPerDay: 2.5 }), (err) => err.status === 400);
    assert.throws(() => settings.update({ dailyTradeLimitEnabled: 'si' }), (err) => err.status === 400);
  });

  it('límite diario: un 0 antiguo (sin límite) en el archivo pasa al valor por defecto', () => {
    fs.writeFileSync(
      process.env.MT5_SETTINGS_PATH,
      JSON.stringify({ active: 'principal', profiles: { principal: { maxTradesPerDay: 0 }, secundaria: { maxTradesPerDay: 15 } } })
    );
    settings._resetForTests();
    assert.equal(settings.get('principal').maxTradesPerDay, 6);
    assert.equal(settings.get('principal').dailyTradeLimitEnabled, true);
    assert.equal(settings.get('secundaria').maxTradesPerDay, 15);
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

  it('volatilidad: por defecto desactivada con niveles 15/20/30 y multiplicadores 0,8/1/1,3/1,6', () => {
    const s = settings.get();
    assert.equal(s.volatilityAdjustEnabled, false);
    assert.equal(s.vixSymbol, '');
    assert.deepEqual([s.vixLowMax, s.vixNormalMax, s.vixHighMax], [15, 20, 30]);
    assert.deepEqual([s.vixMultLow, s.vixMultNormal, s.vixMultHigh, s.vixMultExtreme], [0.8, 1, 1.3, 1.6]);
  });

  it('volatilidad: guarda toggle y multiplicadores; apagar el toggle conserva los multiplicadores', () => {
    settings.update({ volatilityAdjustEnabled: true, vixMultHigh: 1.5, vixHighMax: 28, vixSymbol: 'VIX.cash' });
    settings.update({ volatilityAdjustEnabled: false });
    settings._resetForTests();
    const s = settings.get();
    assert.equal(s.volatilityAdjustEnabled, false);
    assert.equal(s.vixMultHigh, 1.5);
    assert.equal(s.vixHighMax, 28);
    assert.equal(s.vixSymbol, 'VIX.cash');
    assert.equal(settings.get('secundaria').vixMultHigh, 1.3);
  });

  it('volatilidad: valida tipos, rangos y orden de umbrales', () => {
    const { value, errors } = settings.validatePatch({
      volatilityAdjustEnabled: 'si',
      vixMultLow: 0.1,
      vixMultExtreme: 5,
      vixLowMax: 0,
      vixSymbol: 'VIX uno',
    });
    assert.deepEqual(value, {});
    assert.equal(errors.length, 5);
    assert.deepEqual(settings.validatePatch({ vixSymbol: '', vixMultLow: 0.2, vixMultExtreme: 4 }).errors, []);
    assert.throws(() => settings.update({ vixLowMax: 25 }), (err) => err.status === 400 && /baja < normal < alta/.test(err.message));
    assert.throws(() => settings.update({ vixHighMax: 18 }), (err) => err.status === 400);
    assert.equal(settings.get().vixLowMax, 15);
    settings.update({ vixLowMax: 10, vixNormalMax: 18, vixHighMax: 25 });
    assert.equal(settings.get().vixHighMax, 25);
  });

  it('volatilidad: umbrales desordenados en el archivo vuelven a los de fábrica al cargar', () => {
    fs.writeFileSync(
      process.env.MT5_SETTINGS_PATH,
      JSON.stringify({ profiles: { principal: { vixLowMax: 40, vixMultHigh: 2 } } })
    );
    settings._resetForTests();
    assert.deepEqual([settings.get().vixLowMax, settings.get().vixNormalMax, settings.get().vixHighMax], [15, 20, 30]);
    assert.equal(settings.get().vixMultHigh, 2);
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
