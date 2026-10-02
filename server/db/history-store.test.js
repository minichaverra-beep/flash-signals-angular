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

  it('updatePlanLevels: niveles de MT5 recalculan riesgo y R:R; conserva el plan original', async () => {
    const { id } = await store.insertSnapshot(
      sampleSnap({
        summary: {
          planDetails: { entry: '50628.4', sl: '50566.3', tp: '50752.8', rr: '1:2', risk: '62.2', trigger: 'x' },
        },
      })
    );
    const r = await store.updatePlanLevels(id, { entry: 50725.1, sl: 50615, tp: 50916.8 });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    const { summary } = await store.getById(id);
    assert.deepEqual(
      { entry: summary.planDetails.entry, sl: summary.planDetails.sl, tp: summary.planDetails.tp },
      { entry: '50725.1', sl: '50615', tp: '50916.8' }
    );
    assert.equal(summary.planDetails.risk, '110.1');
    assert.equal(summary.planDetails.rr, '1:1.7');
    assert.equal(summary.planDetails.trigger, 'x');
    assert.deepEqual(summary.planOriginal, {
      entry: '50628.4', sl: '50566.3', tp: '50752.8', rr: '1:2', risk: '62.2',
    });

    await store.updatePlanLevels(id, { entry: 50700, sl: 50600, tp: 50900 });
    const again = await store.getById(id);
    assert.equal(again.summary.planDetails.rr, '1:2');
    assert.equal(again.summary.planOriginal.entry, '50628.4');
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

  it('updateMt5Execution guarda la ejecución real sin tocar el plan; editar el PnL a mano quita el origen MT5', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    const before = await store.getById(id);
    assert.equal(before.real, null);
    assert.equal(before.pnlSource, null);

    const real = {
      ticket: 680126942,
      entry: 84792.7,
      exit: 84610.17,
      sl: 85001.08,
      openedAt: '2026-10-01T20:21:00Z',
      closedAt: '2026-10-01T20:54:12Z',
    };
    const a = await store.updateMt5Execution(id, { ...real, pnlUsd: 74.84 });
    assert.equal(a.ok, true);
    assert.deepEqual(a.item.real, {
      ...real,
      openedAt: '2026-10-01T20:21:00.000Z',
      closedAt: '2026-10-01T20:54:12.000Z',
    });
    assert.equal(a.item.pnlUsd, 74.84);
    assert.equal(a.item.pnlSource, 'mt5');
    assert.deepEqual(a.item.summary.planDetails, before.summary.planDetails);

    const listed = (await store.listHistory({ pageSize: 5 })).items.find((i) => i.id === id);
    assert.equal(listed.real.exit, 84610.17);
    assert.equal(listed.pnlSource, 'mt5');

    const manual = await store.updateAnnotation(id, { pnlUsd: 70 });
    assert.equal(manual.item.pnlSource, null);
    assert.equal(manual.item.real.ticket, 680126942);

    const onlyReal = await store.updateMt5Execution(id, real);
    assert.equal(onlyReal.item.pnlUsd, 70);
    assert.equal((await store.updateMt5Execution(id, { ticket: 0 })).ok, false);
    assert.equal((await store.updateMt5Execution(999999, real)).error, 'not_found');
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

  it('listHistory: filtro Dirección (cualquiera / sin) y Confluencias (todas / ninguna)', async () => {
    const tags = await store.listTags();
    const [t1, t2] = tags;
    const [c1, c2] = await store.listConfluencias();
    const { id: a } = await store.insertSnapshot(sampleSnap());
    const { id: b } = await store.insertSnapshot(sampleSnap({ market: 'us30' }));
    const { id: c } = await store.insertSnapshot(sampleSnap());
    await store.updateAnnotation(a, { tagIds: [t1.id], confluenceIds: [c1.id, c2.id] });
    await store.updateAnnotation(b, { tagIds: [t2.id], confluenceIds: [c1.id] });
    const ids = async (opts) => (await store.listHistory({ pageSize: 10, ...opts })).items.map((i) => i.id).sort();

    assert.deepEqual(await ids({ tagIds: [t1.id] }), [a]);
    assert.deepEqual(await ids({ tagIds: [t1.id, t2.id] }), [a, b]);
    assert.deepEqual(await ids({ tagNone: true }), [c]);
    assert.deepEqual(await ids({ tagIds: [t2.id], tagNone: true }), [b, c]);
    assert.deepEqual(await ids({ confluenciaIds: [c1.id] }), [a, b]);
    assert.deepEqual(await ids({ confluenciaIds: [c1.id, c2.id] }), [a]);
    assert.deepEqual(await ids({ confluenciaNone: true }), [c]);
    assert.deepEqual(await ids({ market: 'btc', confluenciaIds: [c1.id] }), [a]);
    assert.equal((await store.listHistory({ tagIds: [t1.id] })).total, 1);
    assert.deepEqual(await ids({ tagIds: ['x', -1, '1;DROP'] }), [a, b, c]);
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

  it('migración 011: columnas locked/locked_at y filas nuevas desbloqueadas', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    const item = await store.getById(id);
    assert.equal(item.locked, false);
    assert.equal(item.lockedAt, null);
    const listed = await store.listHistory({ pageSize: 5 });
    assert.equal(listed.items.find((i) => i.id === id)?.locked, false);
  });

  it('setLocked bloquea/desbloquea; valida id, boolean y existencia', async () => {
    const { id } = await store.insertSnapshot(sampleSnap());
    const locked = await store.setLocked(id, true);
    assert.equal(locked.ok, true);
    assert.equal(locked.item.locked, true);
    assert.ok(locked.item.lockedAt);
    const listed = await store.listHistory({ pageSize: 5 });
    assert.equal(listed.items.find((i) => i.id === id)?.locked, true);

    const unlocked = await store.setLocked(id, false);
    assert.equal(unlocked.ok, true);
    assert.equal(unlocked.item.locked, false);
    assert.equal(unlocked.item.lockedAt, null);

    assert.equal((await store.setLocked(id, 'yes')).ok, false);
    assert.equal((await store.setLocked(0, true)).error, 'id inválido');
    assert.equal((await store.setLocked(99999, true)).error, 'not_found');
  });

  it('fila bloqueada rechaza anotaciones, imagen, MT5, plan y borrado; desbloquear vuelve a permitir', async () => {
    const { id } = await store.insertSnapshot(
      sampleSnap({ summary: { verdict: 'OPERAR_LONG', planDetails: { entry: '100', sl: '90', tp: '120' } } })
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    await store.updateAnnotation(id, { comment: 'antes' });
    await store.setLocked(id, true);
    const L = store.LOCKED_ERROR;

    assert.equal((await store.updateAnnotation(id, { comment: 'después' })).error, L);
    assert.equal((await store.updateAnnotation(id, { tagIds: [] })).error, L);
    assert.equal((await store.updateAnnotation(id, { confluenceIds: [] })).error, L);
    assert.equal((await store.saveResultImage(id, png, 'image/png')).error, L);
    assert.equal((await store.deleteResultImage(id)).error, L);
    assert.equal((await store.updateMt5Execution(id, { ticket: 7, entry: 101, pnlUsd: 5 })).error, L);
    assert.equal((await store.updatePlanLevels(id, { entry: 105 })).error, L);
    const del = await store.deleteById(id);
    assert.equal(del.deleted, 0);
    assert.equal(del.error, L);

    const still = await store.getById(id);
    assert.equal(still.comment, 'antes');
    assert.equal(still.hasResultImage, false);
    assert.equal(still.real, null);
    assert.equal(still.summary.planDetails.entry, '100');

    await store.setLocked(id, false);
    assert.equal((await store.updateAnnotation(id, { comment: 'después' })).ok, true);
    assert.equal((await store.deleteById(id)).deleted, 1);
  });

  describe('bloqueo por fecha (día local anterior)', () => {
    const DAY = 24 * 60 * 60 * 1000;

    afterEach(() => {
      store._setClockForTests(null);
      delete process.env.HISTORY_TZ;
    });

    async function insertAt(iso) {
      store._setClockForTests(() => new Date(iso));
      const { id } = await store.insertSnapshot(sampleSnap());
      store._setClockForTests(null);
      return id;
    }

    it('frontera: 23:59 de ayer bloqueada, 00:01 de hoy y día UTC siguiente editables', async () => {
      process.env.HISTORY_TZ = 'America/Bogota';
      const yesterday = await insertAt('2026-10-01T04:59:00.000Z'); // 30-sep 23:59 local
      const today = await insertAt('2026-10-01T05:01:00.000Z'); // 01-oct 00:01 local
      const utcNext = await insertAt('2026-10-02T03:30:00.000Z'); // 01-oct 22:30 local
      store._setClockForTests(() => new Date('2026-10-02T04:30:00.000Z')); // 01-oct 23:30 local

      const listed = await store.listHistory({ pageSize: 10 });
      assert.equal(listed.lockTz, 'America/Bogota');
      const byId = new Map(listed.items.map((i) => [i.id, i]));
      assert.equal(byId.get(yesterday).autoLocked, true);
      assert.equal(byId.get(yesterday).effectiveLocked, true);
      assert.equal(byId.get(yesterday).locked, false);
      assert.equal(byId.get(today).effectiveLocked, false);
      assert.equal(byId.get(utcNext).effectiveLocked, false);

      assert.equal((await store.updateAnnotation(yesterday, { comment: 'x' })).error, store.LOCKED_ERROR);
      assert.equal((await store.updateAnnotation(today, { comment: 'x' })).ok, true);
      assert.equal((await store.updateAnnotation(utcNext, { comment: 'x' })).ok, true);
    });

    it('fila de un día anterior rechaza todas las mutaciones', async () => {
      const id = await insertAt(new Date(Date.now() - 3 * DAY).toISOString());
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
      );
      const L = store.LOCKED_ERROR;
      assert.equal((await store.updateAnnotation(id, { resultado: 'ganada' })).error, L);
      assert.equal((await store.saveResultImage(id, png, 'image/png')).error, L);
      assert.equal((await store.updateMt5Execution(id, { ticket: 9, pnlUsd: 3 })).error, L);
      assert.equal((await store.updatePlanLevels(id, { entry: 1 })).error, L);
      assert.equal((await store.deleteById(id)).error, L);
    });

    it('desbloquear guarda override; volver a bloquear lo limpia', async () => {
      const id = await insertAt(new Date(Date.now() - 3 * DAY).toISOString());

      const unlocked = await store.setLocked(id, false);
      assert.equal(unlocked.item.unlockOverride, true);
      assert.equal(unlocked.item.autoLocked, false);
      assert.equal(unlocked.item.effectiveLocked, false);
      assert.equal((await store.updateAnnotation(id, { comment: 'editada' })).ok, true);

      // Re-bloquear una fila antigua vuelve al bloqueo por fecha (estado original, sin manual).
      const relocked = await store.setLocked(id, true);
      assert.equal(relocked.item.unlockOverride, false);
      assert.equal(relocked.item.locked, false);
      assert.equal(relocked.item.autoLocked, true);
      assert.equal(relocked.item.effectiveLocked, true);
      assert.equal((await store.updateAnnotation(id, { comment: 'no' })).error, store.LOCKED_ERROR);

      const again = await store.setLocked(id, false);
      assert.equal(again.item.unlockOverride, true);
      assert.equal(again.item.effectiveLocked, false);
    });

    it('filas de hoy: solo candado manual, sin override', async () => {
      const { id } = await store.insertSnapshot(sampleSnap());
      const item = await store.getById(id);
      assert.equal(item.autoLocked, false);
      assert.equal(item.effectiveLocked, false);
      await store.setLocked(id, true);
      const off = await store.setLocked(id, false);
      assert.equal(off.item.unlockOverride, false);
      assert.equal(off.item.effectiveLocked, false);
    });
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

    assert.equal((await store.setLocked(id, true)).item.locked, true);
    assert.equal((await store.deleteById(id)).error, store.LOCKED_ERROR);
    assert.equal((await store.setLocked(id, false)).item.locked, false);

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
