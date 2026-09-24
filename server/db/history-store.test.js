/**
 * Tests del hive box (history-store) con DB temporal.
 * Cubren better-sqlite3 (default) y fallback sql.js.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const STORE_PATH = require.resolve('./history-store.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTempDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loadStore(dataDir) {
  process.env.HISTORY_DATA_DIR = dataDir;
  delete require.cache[STORE_PATH];
  return require('./history-store.js');
}

function sampleSnap(overrides = {}) {
  return {
    market: 'btc',
    tier: 'high',
    status: 'done',
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:01:00.000Z',
    flags: { ml: true, neural: false },
    entry: '92000',
    verdict: 'OPERAR_LONG',
    summary: {
      verdict: 'OPERAR_LONG',
      scoreCombined: 72,
      price: '92100',
    },
    reportPath: '/tmp/report.md',
    chartPath: '/tmp/chart.png',
    preview: '# preview',
    command: 'python run.py',
    exitCode: 0,
    error: null,
    ...overrides,
  };
}

describe('history-store (better-sqlite3 o motor disponible)', () => {
  /** @type {string} */
  let tempDir;
  /** @type {typeof import('./history-store')} */
  let store;

  before(() => {
    tempDir = makeTempDir('fs-hist-');
    store = loadStore(tempDir);
  });

  after(() => {
    store?._resetForTests();
    delete require.cache[STORE_PATH];
    delete process.env.HISTORY_DATA_DIR;
    rmTempDir(tempDir);
  });

  beforeEach(async () => {
    await store.clearAll();
  });

  it('insertSnapshot devuelve id y persiste archivo sqlite', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    assert.equal(typeof id, 'number');
    assert.ok(id >= 1);
    assert.ok(fs.existsSync(store.DB_PATH));
  });

  it('listHistory: vacío, luego items, paginación y filtro market', async () => {
    let empty = await store.listHistory();
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.page, 1);
    assert.equal(empty.totalPages, 1);

    await store.insertSnapshot(sampleSnap({ market: 'btc' }));
    await store.insertSnapshot(
      sampleSnap({ market: 'us30', summary: { verdict: 'ESPERAR', scoreCombined: 40 } })
    );
    await store.insertSnapshot(sampleSnap({ market: 'btc', tier: 'light' }));

    const all = await store.listHistory({ pageSize: 10 });
    assert.equal(all.total, 3);
    assert.equal(all.items.length, 3);
    assert.ok(all.items.every((i) => i.id && i.createdAt && i.market));

    const btc = await store.listHistory({ market: 'btc' });
    assert.equal(btc.total, 2);
    assert.ok(btc.items.every((i) => i.market === 'btc'));

    const page1 = await store.listHistory({ page: 1, pageSize: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.totalPages, 2);
    assert.equal(page1.total, 3);

    const page2 = await store.listHistory({ page: 2, pageSize: 2 });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.page, 2);
  });

  it('getById: detalle con summary parseado; ids inválidos → null', async () => {
    const { id } = await store.insertSnapshot(
      sampleSnap({
        flags: { bullish: true, bearish: false, ml: true },
        summary: {
          verdict: 'OPERAR_LONG',
          scoreCombined: 72,
          price: '92100',
          bias: 'bullish',
        },
      })
    );
    const detail = await store.getById(id);
    assert.ok(detail);
    assert.equal(detail.id, id);
    assert.equal(detail.market, 'btc');
    assert.equal(detail.verdict, 'OPERAR_LONG');
    assert.equal(detail.scoreCombined, 72);
    assert.equal(detail.summary?.price, '92100');
    assert.equal(detail.reportPath, '/tmp/report.md');
    assert.equal(detail.flags?.ml, true);
    assert.equal(detail.bias, 'bullish');

    assert.equal(await store.getById(0), null);
    assert.equal(await store.getById(-1), null);
    assert.equal(await store.getById('x'), null);
    assert.equal(await store.getById(999999), null);
  });

  it('listHistory expone bias desde flags o summary', async () => {
    await store.insertSnapshot(
      sampleSnap({
        flags: { bullish: false, bearish: true },
        summary: { verdict: 'OPERAR_SHORT', scoreCombined: 55, bias: 'ignored-when-flag' },
      })
    );
    await store.insertSnapshot(
      sampleSnap({
        market: 'us30',
        flags: { bullish: false, bearish: false },
        summary: { verdict: 'ESPERAR', scoreCombined: 40, bias: 'auto' },
      })
    );
    await store.insertSnapshot(
      sampleSnap({
        market: 'xauusd',
        flags: { ml: true },
        summary: { verdict: 'OPERAR_LONG', scoreCombined: 60, bias: 'alcista' },
      })
    );

    const all = await store.listHistory({ pageSize: 10 });
    assert.equal(all.total, 3);
    const byMarket = Object.fromEntries(all.items.map((i) => [i.market, i.bias]));
    assert.equal(byMarket.btc, 'bearish');
    assert.equal(byMarket.us30, 'auto');
    assert.equal(byMarket.xauusd, 'alcista');
  });

  it('deleteById elimina uno y no afecta otros', async () => {
    const a = await store.insertSnapshot(sampleSnap({ market: 'btc' }));
    const b = await store.insertSnapshot(sampleSnap({ market: 'us30' }));

    const del = await store.deleteById(a.id);
    assert.equal(del.deleted, 1);
    assert.equal(await store.getById(a.id), null);
    assert.ok(await store.getById(b.id));

    const miss = await store.deleteById(a.id);
    assert.equal(miss.deleted, 0);
    assert.equal((await store.deleteById(0)).deleted, 0);
  });

  it('clearAll borra todo el historial', async () => {
    await store.insertSnapshot(sampleSnap());
    await store.insertSnapshot(sampleSnap({ market: 'us30' }));
    const cleared = await store.clearAll();
    assert.ok(cleared.deleted >= 2);
    const list = await store.listHistory();
    assert.equal(list.total, 0);
    assert.deepEqual(list.items, []);
  });

  it('listHistory ignora market inválido (trata como todos)', async () => {
    await store.insertSnapshot(sampleSnap({ market: 'btc' }));
    await store.insertSnapshot(sampleSnap({ market: 'us30' }));
    const list = await store.listHistory({ market: 'eth' });
    assert.equal(list.total, 2);
  });

  it('updateAnnotation guarda comment y resultado (ganada/perdida)', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    const a = await store.updateAnnotation(id, {
      comment: '  FVG hold ok  ',
      resultado: 'ganada',
    });
    assert.equal(a.ok, true);
    assert.equal(a.item?.comment, 'FVG hold ok');
    assert.equal(a.item?.resultado, 'ganada');

    const listed = await store.listHistory({ pageSize: 5 });
    const row = listed.items.find((i) => i.id === id);
    assert.equal(row?.comment, 'FVG hold ok');
    assert.equal(row?.resultado, 'ganada');

    const b = await store.updateAnnotation(id, { resultado: 'win' });
    assert.equal(b.ok, true);
    assert.equal(b.item?.resultado, 'ganada');

    const c = await store.updateAnnotation(id, { resultado: '' });
    assert.equal(c.ok, true);
    assert.equal(c.item?.resultado, null);

    const d = await store.updateAnnotation(id, { resultado: ' Empate ' });
    assert.equal(d.ok, false);

    const miss = await store.updateAnnotation(999999, { comment: 'x' });
    assert.equal(miss.ok, false);
    assert.equal(miss.error, 'not_found');
  });
});

describe('history-store fallback sql.js', () => {
  /** @type {string} */
  let tempDir;
  /** @type {typeof import('./history-store')} */
  let store;
  /** @type {typeof Module._load} */
  let originalLoad;

  before(async () => {
    tempDir = makeTempDir('fs-hist-sqljs-');
    process.env.HISTORY_DATA_DIR = tempDir;
    delete require.cache[STORE_PATH];

    originalLoad = Module._load;
    Module._load = function patched(request, parent, isMain) {
      if (request === 'better-sqlite3') {
        throw new Error('simulated native bind failure');
      }
      return originalLoad.apply(this, arguments);
    };

    store = require('./history-store.js');
    const kind = await store.getBackendKind();
    assert.equal(kind, 'sql.js');
  });

  after(() => {
    Module._load = originalLoad;
    store?._resetForTests();
    delete require.cache[STORE_PATH];
    delete process.env.HISTORY_DATA_DIR;
    rmTempDir(tempDir);
  });

  afterEach(async () => {
    await store.clearAll();
  });

  it('insert / list / get / delete / clear con sql.js', async () => {
    const { id } = await store.insertSnapshot(
      sampleSnap({
        market: 'us30',
        summary: { verdict: 'NO_OPERAR', scoreCombined: 15 },
      })
    );
    assert.ok(id >= 1);
    assert.ok(fs.existsSync(store.DB_PATH));

    const list = await store.listHistory({ market: 'us30' });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].verdict, 'NO_OPERAR');
    assert.equal(list.items[0].scoreCombined, 15);

    const detail = await store.getById(id);
    assert.equal(detail?.summary?.verdict, 'NO_OPERAR');
    assert.equal(detail?.preview, '# preview');

    const del = await store.deleteById(id);
    assert.equal(del.deleted, 1);
    assert.equal(await store.getById(id), null);

    await store.insertSnapshot(sampleSnap());
    await store.insertSnapshot(sampleSnap({ market: 'us30' }));
    const cleared = await store.clearAll();
    assert.ok(cleared.deleted >= 2);
    assert.equal((await store.listHistory()).total, 0);
  });
});
