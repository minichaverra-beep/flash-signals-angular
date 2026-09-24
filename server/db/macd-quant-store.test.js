/**
 * Tests del historial MACD-quant (macd-quant-store) con DB temporal.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_PATH = require.resolve('./macd-quant-store.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTempDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loadStore(dataDir) {
  process.env.MACD_QUANT_DATA_DIR = dataDir;
  delete require.cache[STORE_PATH];
  return require('./macd-quant-store.js');
}

describe('macd-quant-store', () => {
  /** @type {string} */
  let tempDir;
  /** @type {typeof import('./macd-quant-store')} */
  let store;
  /** @type {string} */
  let fakePng;

  before(() => {
    tempDir = makeTempDir('fs-macd-');
    store = loadStore(tempDir);
    fakePng = path.join(tempDir, 'btc_h4_macd_quant.png');
    fs.writeFileSync(fakePng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  after(() => {
    store?._resetForTests();
    delete require.cache[STORE_PATH];
    delete process.env.MACD_QUANT_DATA_DIR;
    rmTempDir(tempDir);
  });

  beforeEach(async () => {
    await store.clearAll();
  });

  it('insertAnalysis copia PNG y lista por market', async () => {
    const { id, pngName } = await store.insertAnalysis({
      market: 'btc',
      timeframe: 'H4',
      days: 7,
      status: 'done',
      sourcePngPath: fakePng,
      command: 'python -m scripts.plot_macd_quant --symbol btc --days 7',
      exitCode: 0,
      softFilter: { macdQuant: true },
    });
    assert.ok(id >= 1);
    assert.ok(pngName);
    assert.ok(fs.existsSync(path.join(store.CHARTS_DIR, pngName)));
    assert.ok(fs.existsSync(store.DB_PATH));

    const listed = await store.listAnalyses({ market: 'btc' });
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].market, 'btc');
    assert.equal(listed.items[0].timeframe, 'H4');
    assert.equal(listed.items[0].days, 7);
    assert.equal(listed.items[0].hasPng, true);
    assert.equal(listed.items[0].params.fast, 12);
    assert.equal(listed.items[0].softFilter.neverTriggerAlone, true);

    const detail = await store.getById(id);
    assert.ok(detail);
    assert.equal(detail.pngName, pngName);

    const chart = await store.getChartFile(id);
    assert.ok(chart);
    assert.ok(fs.existsSync(chart.absPath));
  });

  it('filtra por market y rechaza market inválido en insert', async () => {
    await store.insertAnalysis({
      market: 'us30',
      status: 'done',
      sourcePngPath: fakePng,
    });
    await store.insertAnalysis({
      market: 'xauusd',
      status: 'done',
      sourcePngPath: fakePng,
    });

    const us30 = await store.listAnalyses({ market: 'us30' });
    assert.equal(us30.total, 1);
    assert.equal(us30.items[0].market, 'us30');

    await assert.rejects(
      () => store.insertAnalysis({ market: 'eth', status: 'done' }),
      /market inválido/
    );
  });
});
