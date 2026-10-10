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
  it('auto en escritorio con puente → mt5', () => {
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'auto' }, {}).mode, 'mt5');
    assert.equal(resolveDataSource(bridge, {}).mode, 'mt5'); // sin dataSource = auto
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
  it('ajuste explícito gana a la detección', () => {
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'yahoo' }, {}).mode, 'yahoo');
    assert.equal(resolveDataSource({ ...bridge, dataSource: 'mt5' }, { TERMUX_VERSION: '1' }).mode, 'mt5');
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
    assert.equal(isYahooOnly(bridge, {}), false);
    assert.match(describeDataSource(bridge, { TERMUX_VERSION: '1' }), /solo Yahoo.*MT5 omitido/);
    assert.match(describeDataSource(bridge, {}), /MT5 con respaldo Yahoo/);
  });
});

describe('mt5-settings.dataSource', () => {
  const settings = require('./mt5-settings');

  it('por defecto es auto y el validador solo admite auto|yahoo|mt5', () => {
    assert.equal(settings.defaults().dataSource, 'auto');
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
      assert.equal(settings.get().dataSource, 'auto');
      settings.update({ dataSource: 'yahoo' }, 'principal');
      settings._resetForTests();
      assert.equal(settings.get('principal').dataSource, 'yahoo');
      assert.equal(settings.get('secundaria').dataSource, 'auto');
      assert.equal(settings.toPublic().dataSource, 'yahoo');
    } finally {
      if (prev === undefined) delete process.env.MT5_SETTINGS_PATH;
      else process.env.MT5_SETTINGS_PATH = prev;
      settings._resetForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
