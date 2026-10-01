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
    assert.ok(all.items.every((i) => i.chartPath === '/tmp/chart.png'));

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

  it('listHistory: sortBy/sortDir con vacíos al final y fallback seguro', async () => {
    await store.insertSnapshot(
      sampleSnap({ summary: { scoreCombined: 50, planDetails: { rr: '1:3' } } })
    );
    await store.insertSnapshot(
      sampleSnap({ summary: { scoreCombined: 70, planDetails: { rr: '1:2' } } })
    );
    await store.insertSnapshot(sampleSnap({ summary: { verdict: 'X' } }));

    const asc = await store.listHistory({ sortBy: 'scoreCombined', sortDir: 'asc' });
    assert.deepEqual(asc.items.map((i) => i.scoreCombined), [50, 70, null]);
    const desc = await store.listHistory({ sortBy: 'scoreCombined', sortDir: 'desc' });
    assert.deepEqual(desc.items.map((i) => i.scoreCombined), [70, 50, null]);

    const rr = await store.listHistory({ sortBy: 'plannedRr', sortDir: 'desc' });
    assert.deepEqual(rr.items.map((i) => i.plannedRr), ['1:3', '1:2', null]);

    const bogus = await store.listHistory({ sortBy: 'id; DROP TABLE x', sortDir: 'zz' });
    assert.equal(bogus.total, 3);
    assert.ok(bogus.items[0].id > bogus.items[2].id);
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

  it('listHistory expone winrate (tasa de acierto) desde summary, no el veredicto', async () => {
    const rate = '~82% — patrón ganador similar · histórico El BTC';
    await store.insertSnapshot(
      sampleSnap({
        summary: {
          verdict: 'NO_OPERAR',
          scoreCombined: 22,
          winrate: rate,
        },
      })
    );
    const list = await store.listHistory({ pageSize: 5 });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].verdict, 'NO_OPERAR');
    assert.equal(list.items[0].winrate, rate);

    const detail = await store.getById(list.items[0].id);
    assert.equal(detail?.winrate, rate);
    assert.equal(detail?.summary?.winrate, rate);
  });

  it('listHistory expone plannedRr desde summary.planDetails.rr', async () => {
    await store.insertSnapshot(
      sampleSnap({
        summary: {
          verdict: 'OPERAR_LONG',
          scoreCombined: 62,
          planDetails: { rr: '1:2.4' },
        },
      })
    );
    const list = await store.listHistory({ pageSize: 5 });
    assert.equal(list.items[0].plannedRr, '1:2.4');
    const detail = await store.getById(list.items[0].id);
    assert.equal(detail?.plannedRr, '1:2.4');
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

  it('updateAnnotation guarda comment y resultado (ganada/perdida/no_tomada)', async () => {
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

    const e = await store.updateAnnotation(id, { resultado: 'no-tomada' });
    assert.equal(e.ok, true);
    assert.equal(e.item?.resultado, 'no_tomada');

    const f = await store.updateAnnotation(id, { resultado: 'No tomada' });
    assert.equal(f.ok, true);
    assert.equal(f.item?.resultado, 'no_tomada');

    const miss = await store.updateAnnotation(999999, { comment: 'x' });
    assert.equal(miss.ok, false);
    assert.equal(miss.error, 'not_found');
  });

  it('updateAnnotation guarda pnlUsd (nullable float)', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    const a = await store.updateAnnotation(id, { pnlUsd: 125.5 });
    assert.equal(a.ok, true);
    assert.equal(a.item?.pnlUsd, 125.5);

    const listed = await store.listHistory({ pageSize: 5 });
    const row = listed.items.find((i) => i.id === id);
    assert.equal(row?.pnlUsd, 125.5);

    const b = await store.updateAnnotation(id, { pnl_usd: '-40' });
    assert.equal(b.ok, true);
    assert.equal(b.item?.pnlUsd, -40);

    const c = await store.updateAnnotation(id, { pnlMoney: '' });
    assert.equal(c.ok, true);
    assert.equal(c.item?.pnlUsd, null);

    const bad = await store.updateAnnotation(id, { pnlUsd: 'abc' });
    assert.equal(bad.ok, false);
  });

  it('updateAnnotation guarda motivoEntradaSalida', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    const a = await store.updateAnnotation(id, {
      motivoEntradaSalida: '  Quiebre desde zona premium  ',
    });
    assert.equal(a.ok, true);
    assert.equal(a.item?.motivoEntradaSalida, 'Quiebre desde zona premium');

    const listed = await store.listHistory({ pageSize: 5 });
    const row = listed.items.find((i) => i.id === id);
    assert.equal(row?.motivoEntradaSalida, 'Quiebre desde zona premium');

    const b = await store.updateAnnotation(id, { motivo_entrada_salida: '' });
    assert.equal(b.ok, true);
    assert.equal(b.item?.motivoEntradaSalida, null);
  });

  it('listTags incluye Dirección y se puede asignar a una fila', async () => {
    const tags = await store.listTags();
    const names = tags.map((t) => t.name);
    assert.ok(names.includes('En descuento'));
    assert.ok(names.includes('Dirección'));
    const direccion = tags.find((t) => t.name === 'Dirección');
    assert.ok(direccion);
    assert.equal(direccion.color, '#2563eb');

    const { id } = await store.insertSnapshot(sampleSnap());
    const patched = await store.updateAnnotation(id, {
      tagIds: [direccion.id],
    });
    assert.equal(patched.ok, true);
    assert.equal(patched.item?.tags?.length, 1);
    assert.equal(patched.item?.tags?.[0].name, 'Dirección');

    const listed = await store.listHistory({ pageSize: 5 });
    const row = listed.items.find((i) => i.id === id);
    assert.equal(row?.tags?.[0]?.name, 'Dirección');

    const cleared = await store.updateAnnotation(id, { tagIds: [] });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.item?.tags, []);
  });

  it('listConfluencias seed + multi-select persistente', async () => {
    const catalog = await store.listConfluencias();
    const names = catalog.map((c) => c.name);
    assert.ok(names.includes('Continuación'));
    assert.ok(names.includes('Reversion'));
    assert.ok(names.includes('Macro tendencia'));
    assert.ok(names.includes('Pullback-Continuo'));
    assert.equal(catalog.length >= 13, true);

    const a = catalog.find((c) => c.name === 'Reversion');
    const b = catalog.find((c) => c.name === 'Macro tendencia');
    assert.ok(a && b);
    assert.equal(a.color, '#6b7280');
    assert.equal(b.color, '#ea580c');

    const { id } = await store.insertSnapshot(sampleSnap());
    const patched = await store.updateAnnotation(id, {
      confluenceIds: [a.id, b.id],
    });
    assert.equal(patched.ok, true);
    assert.equal(patched.item?.confluencias?.length, 2);
    const assigned = (patched.item?.confluencias || []).map((c) => c.name).sort();
    assert.deepEqual(assigned, ['Macro tendencia', 'Reversion']);

    const listed = await store.listHistory({ pageSize: 5 });
    const row = listed.items.find((i) => i.id === id);
    assert.equal(row?.confluencias?.length, 2);

    // Seed no duplica al listar de nuevo
    const again = await store.listConfluencias();
    assert.equal(again.filter((c) => c.name === 'Reversion').length, 1);

    const cleared = await store.updateAnnotation(id, { confluenceIds: [] });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.item?.confluencias, []);
  });

  it('saveResultImage / getResultImageFile / deleteResultImage', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    // PNG 1x1 mínimo
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const saved = await store.saveResultImage(id, png, 'image/png');
    assert.equal(saved.ok, true);
    assert.equal(saved.item?.hasResultImage, true);
    assert.equal(saved.item?.resultImageMime, 'image/png');

    const file = await store.getResultImageFile(id);
    assert.ok(file);
    assert.equal(file.mime, 'image/png');
    assert.ok(fs.existsSync(file.absPath));

    const listed = await store.listHistory({ pageSize: 5 });
    const row = listed.items.find((i) => i.id === id);
    assert.equal(row?.hasResultImage, true);

    const deleted = await store.deleteResultImage(id);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.item?.hasResultImage, false);
    assert.equal(await store.getResultImageFile(id), null);
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
