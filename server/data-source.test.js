const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeMode, isAndroid, resolveDataSource, isYahooOnly, describeDataSource,
} = require('./data-source');

const bridge = { bridgeUrl: 'http://127.0.0.1:8765' };

describe('normalizeMode', () => {
  it('acepta auto|yahoo|mt5 (mayúsculas/espacios) y alias', () => {
    assert.equal(normalizeMode(' YAHOO '), 'yahoo');
    assert.equal(normalizeMode('yfinance'), 'yahoo');
    assert.equal(normalizeMode('mt5'), 'mt5');
    assert.equal(normalizeMode('auto'), 'auto');
  });
  it('lo demás es null', () => {
    for (const v of ['', 'binance', undefined, null, 3]) assert.equal(normalizeMode(v), null);
  });
});

describe('isAndroid', () => {
  it('detecta Termux por TERMUX_VERSION, PREFIX o ANDROID_ROOT', () => {
    assert.equal(isAndroid({ TERMUX_VERSION: '0.118' }), true);
    assert.equal(isAndroid({ PREFIX: '/data/data/com.termux/files/usr' }), true);
    assert.equal(isAndroid({ ANDROID_ROOT: '/system' }), true);
  });
  it('escritorio: false', () => {
    assert.equal(isAndroid({}), false);
    assert.equal(isAndroid({ PREFIX: '/usr/local' }), false);
  });
});

describe('resolveDataSource', () => {
  it('auto en escritorio con puente → mt5; sin dataSource → yahoo', () => {
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'auto' }, {}).mode, 'mt5');
    assert.equal(resolveDataSource(bridge, {}).mode, 'yahoo');
  });
  it('auto en Android → yahoo', () => {
    const r = resolveDataSource({ ...bridge, dataSource: 'auto' }, { TERMUX_VERSION: '1' });
    assert.equal(r.mode, 'yahoo');
    assert.match(r.reason, /Android/);
  });
  it('auto sin puente configurado → yahoo', () => {
    assert.equal(resolveDataSource({ bridgeUrl: '  ', dataSource: 'auto' }, {}).mode, 'yahoo');
    assert.equal(resolveDataSource({}, {}).mode, 'yahoo');
  });
  it('ajuste explícito yahoo gana en escritorio; en Android/Termux mt5 queda en Yahoo', () => {
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'yahoo' }, {}).mode, 'yahoo');
    const termux = resolveDataSource({ ...bridge, dataSource: 'mt5' }, { TERMUX_VERSION: '1' });
    assert.equal(termux.mode, 'yahoo');
    assert.match(termux.reason, /Android/);
    assert.equal(
      resolveDataSource({ ...bridge, dataSource: 'mt5' }, { FS_DATA_SOURCE: 'mt5', TERMUX_VERSION: '1' }).mode,
      'yahoo'
    );
  });
  it('pantalla pequeña: siempre solo Yahoo, aunque el ajuste o el entorno pidan MT5', () => {
    const { clientContextMiddleware } = require('./data-source');
    const req = { headers: { 'x-fs-client': 'small' } };
    clientContextMiddleware(req, {}, () => {
      const r = resolveDataSource({ ...bridge, dataSource: 'mt5' }, { FS_DATA_SOURCE: 'mt5' });
      assert.equal(r.mode, 'yahoo');
      assert.match(r.reason, /pantalla pequeña/);
      assert.equal(isYahooOnly({ ...bridge, dataSource: 'mt5' }, { FS_DATA_SOURCE: 'mt5' }), true);
      assert.equal(resolveDataSource({ ...bridge, dataSource: 'auto' }, {}).mode, 'yahoo');
    });
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'mt5' }, {}).mode, 'mt5');
  });
  it('petición sin admin: el ajuste MT5 queda en Yahoo; con admin, el escritorio usa MT5', () => {
    const { clientContextMiddleware, setAdminChecker } = require('./data-source');
    setAdminChecker(() => false);
    clientContextMiddleware({ headers: {} }, {}, () => {
      const r = resolveDataSource({ ...bridge, dataSource: 'mt5' }, {});
      assert.equal(r.mode, 'yahoo');
      assert.match(r.reason, /admin/);
    });
    setAdminChecker(() => true);
    try {
      clientContextMiddleware({ headers: {} }, {}, () => {
        assert.equal(resolveDataSource({ ...bridge, dataSource: 'mt5' }, {}).mode, 'mt5');
      });
    } finally {
      setAdminChecker(() => false);
    }
  });
  it('env FS_DATA_SOURCE gana al ajuste; valores inválidos se ignoran', () => {
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'mt5' }, { FS_DATA_SOURCE: 'yahoo' }).mode, 'yahoo');
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'yahoo' }, { FS_DATA_SOURCE: 'mt5' }).mode, 'mt5');
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'yahoo' }, { FS_DATA_SOURCE: 'auto' }).mode, 'mt5');
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'yahoo' }, { FS_DATA_SOURCE: 'basura' }).mode, 'yahoo');
  });
  it('FS_DISABLE_MT5=1 fuerza yahoo', () => {
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'mt5' }, { FS_DISABLE_MT5: '1' }).mode, 'yahoo');
  });
  it('isYahooOnly y describeDataSource', () => {
    assert.equal(isYahooOnly(bridge, { TERMUX_VERSION: '1' }), true);
    assert.equal(isYahooOnly(bridge, {}), true);
    assert.equal(isYahooOnly({ ...bridge, dataSource: 'mt5' }, {}), false);
    assert.match(describeDataSource(bridge, { TERMUX_VERSION: '1' }), /solo Yahoo.*MT5 omitido/);
    assert.match(describeDataSource({ ...bridge, dataSource: 'mt5' }, {}), /MT5 con respaldo Yahoo/);
  });
});

describe('mt5-settings.dataSource', () => {
  const settings = require('./mt5-settings');

  it('por defecto es yahoo y el validador solo admite auto|yahoo|mt5', () => {
    assert.equal(settings.defaults().dataSource, 'yahoo');
    assert.deepEqual(settings.validatePatch({ dataSource: 'yahoo' }), { value: { dataSource: 'yahoo' }, errors: [] });
    assert.deepEqual(settings.validatePatch({ dataSource: ' MT5 ' }).value, { dataSource: 'mt5' });
    const bad = settings.validatePatch({ dataSource: 'binance' });
    assert.deepEqual(bad.value, {});
    assert.match(bad.errors[0], /dataSource/);
    assert.equal(settings.validatePatch({ dataSource: 5 }).errors.length, 1);
  });

  it('update persiste y get lo devuelve (sin tocar el token)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-ds-'));
    const prev = process.env.MT5_SETTINGS_PATH;
    process.env.MT5_SETTINGS_PATH = path.join(dir, 'mt5-settings.json');
    try {
      settings._resetForTests();
      assert.equal(settings.get().dataSource, 'yahoo');
      settings.update({ dataSource: 'mt5' }, 'principal');
      settings._resetForTests();
      assert.equal(settings.get('principal').dataSource, 'mt5');
      assert.equal(settings.get('secundaria').dataSource, 'yahoo');
      assert.equal(settings.toPublic().dataSource, 'mt5');
    } finally {
      if (prev === undefined) delete process.env.MT5_SETTINGS_PATH;
      else process.env.MT5_SETTINGS_PATH = prev;
      settings._resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
