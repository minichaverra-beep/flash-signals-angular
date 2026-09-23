/**
 * Tests del wiki-store (categorías + artifact_meta) con DB temporal.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STORE_PATH = require.resolve('./wiki-store.js');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTempDir(dir) {
  if (dir && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function loadStore(dataDir) {
  process.env.WIKI_DATA_DIR = dataDir;
  delete require.cache[STORE_PATH];
  return require('./wiki-store.js');
}

describe('wiki-store categorías y meta', () => {
  /** @type {string} */
  let tempDir;
  /** @type {typeof import('./wiki-store')} */
  let store;

  before(() => {
    tempDir = makeTempDir('fs-wiki-');
    store = loadStore(tempDir);
  });

  after(() => {
    store?._resetForTests();
    delete require.cache[STORE_PATH];
    delete process.env.WIKI_DATA_DIR;
    rmTempDir(tempDir);
  });

  beforeEach(async () => {
    await store.clearAll();
  });

  it('crea, lista y actualiza categorías', async () => {
    const a = await store.createCategory({ name: 'Informes', color: '#c44' });
    assert.equal(a.ok, true);
    assert.equal(a.category.name, 'Informes');
    assert.equal(a.category.color, '#c44');
    assert.ok(a.category.id >= 1);

    const b = await store.createCategory({ name: 'Notas', sortOrder: 5 });
    assert.equal(b.ok, true);
    assert.equal(b.category.sortOrder, 5);

    const list = await store.listCategories();
    assert.equal(list.length, 2);

    const upd = await store.updateCategory(a.category.id, {
      name: 'Reportes',
      sortOrder: 1,
    });
    assert.equal(upd.ok, true);
    assert.equal(upd.category.name, 'Reportes');
    assert.equal(upd.category.sortOrder, 1);

    const bad = await store.createCategory({ name: '  ' });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
  });

  it('upsert meta por path y asigna categoría', async () => {
    const cat = await store.createCategory({ name: 'Wiki' });
    const up = await store.upsertMeta({
      path: 'foo/bar.md',
      displayName: 'Bar display',
      categoryId: cat.category.id,
    });
    assert.equal(up.ok, true);
    assert.equal(up.meta.path, 'foo/bar.md');
    assert.equal(up.meta.displayName, 'Bar display');
    assert.equal(up.meta.categoryId, cat.category.id);

    const got = await store.getMeta('foo/bar.md');
    assert.equal(got.displayName, 'Bar display');

    const cleared = await store.upsertMeta({
      path: 'foo/bar.md',
      categoryId: null,
    });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.meta.categoryId, null);
    assert.equal(cleared.meta.displayName, 'Bar display');

    assert.equal((await store.upsertMeta({ path: '../x' })).ok, false);
  });

  it('borra categoría vacía; con meta exige reassignTo o force', async () => {
    const cat = await store.createCategory({ name: 'Temp' });
    const emptyDel = await store.deleteCategory(cat.category.id);
    assert.equal(emptyDel.ok, true);

    const c2 = await store.createCategory({ name: 'Con items' });
    const c3 = await store.createCategory({ name: 'Destino' });
    await store.upsertMeta({
      path: 'a.md',
      displayName: 'A',
      categoryId: c2.category.id,
    });

    const conflict = await store.deleteCategory(c2.category.id);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, 409);

    const moved = await store.deleteCategory(c2.category.id, {
      reassignTo: c3.category.id,
    });
    assert.equal(moved.ok, true);
    assert.equal((await store.getMeta('a.md')).categoryId, c3.category.id);

    await store.upsertMeta({
      path: 'b.md',
      displayName: 'B',
      categoryId: c3.category.id,
    });
    const forced = await store.deleteCategory(c3.category.id, { force: true });
    assert.equal(forced.ok, true);
    assert.equal((await store.getMeta('b.md')).categoryId, null);
  });

  it('moveMetaPath migra PK al renombrar', async () => {
    await store.upsertMeta({
      path: 'old.md',
      displayName: 'Viejo',
      categoryId: null,
    });
    const moved = await store.moveMetaPath('old.md', 'new.md', 'Nuevo título');
    assert.equal(moved.ok, true);
    assert.equal(moved.pathChanged, true);
    assert.equal(await store.getMeta('old.md'), null);
    assert.equal((await store.getMeta('new.md')).displayName, 'Nuevo título');
  });

  it('safeFileBaseName limpia caracteres peligrosos y conserva fallbackExt', () => {
    assert.equal(store.safeFileBaseName('ok name.md', '.md'), 'ok name.md');
    assert.equal(store.safeFileBaseName('otro.html', '.md'), 'otro.md');
    assert.ok(!store.safeFileBaseName('../x', '.md').includes('..'));
    assert.ok(store.safeFileBaseName('sin-ext', '.html').endsWith('.html'));
  });

  it('sanitizeDisplayName / stripDisplayExtension ocultan extensiones', () => {
    assert.equal(store.stripDisplayExtension('README.md'), 'README');
    assert.equal(store.stripDisplayExtension('Gestión del dinero.html'), 'Gestión del dinero');
    assert.equal(store.stripDisplayExtension('v1.2'), 'v1.2');
    assert.equal(store.sanitizeArtifactDisplayName('  Informe.pdf  '), 'Informe');
    assert.equal(store.sanitizeDisplayName('Docs.md'), 'Docs.md');
  });
});
