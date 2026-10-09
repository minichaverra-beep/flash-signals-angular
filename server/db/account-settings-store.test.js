/**
 * Tests de ajustes de cuenta (account-settings-store + rutas) con DB temporal.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { registerAccountSettingsRoutes } = require('../account-settings-routes');

const STORE_PATH = require.resolve('./account-settings-store.js');

function loadStore(dataDir) {
  process.env.ACCOUNT_SETTINGS_DATA_DIR = dataDir;
  delete require.cache[STORE_PATH];
  return require('./account-settings-store.js');
}

describe('account-settings-store', () => {
  let tempDir;
  /** @type {typeof import('./account-settings-store')} */
  let store;

  beforeEach(() => {
    store?._resetForTests();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-account-'));
    store = loadStore(tempDir);
  });

  after(() => {
    store?._resetForTests();
    delete require.cache[STORE_PATH];
    delete process.env.ACCOUNT_SETTINGS_DATA_DIR;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('sin fila devuelve valores vacíos', async () => {
    assert.deepEqual(await store.get(), { balance: null, currency: 'USD', riskPct: null, updatedAt: null });
  });

  it('update persiste y conserva los campos no enviados', async () => {
    const saved = await store.update({ balance: '5000.456', riskPct: 1 });
    assert.equal(saved.balance, 5000.46);
    assert.equal(saved.riskPct, 1);
    assert.ok(saved.updatedAt);
    await store.update({ riskPct: 2.5 });
    assert.equal((await store.get()).balance, 5000.46);

    store._resetForTests();
    store = loadStore(tempDir);
    const reloaded = await store.get();
    assert.equal(reloaded.balance, 5000.46);
    assert.equal(reloaded.riskPct, 2.5);
    assert.ok(fs.existsSync(store.DB_PATH));
  });

  it('valida balance > 0, riskPct 0.01–100 y moneda', async () => {
    for (const balance of [0, -10, 'abc', true]) {
      await assert.rejects(() => store.update({ balance }), (err) => err.status === 400);
    }
    for (const riskPct of [0, 0.001, 101, 'x']) {
      await assert.rejects(() => store.update({ riskPct }), (err) => err.status === 400);
    }
    await assert.rejects(() => store.update({ currency: 'dólar' }), (err) => err.status === 400);
    await assert.rejects(() => store.update({}), (err) => err.status === 400);
    assert.equal((await store.update({ riskPct: 0.01, currency: 'eur' })).currency, 'EUR');
  });

  it('importLegacy solo importa con la tabla vacía', async () => {
    assert.equal(await store.importLegacy({ accountBalance: null, riskPct: null }), false);
    assert.equal(await store.importLegacy({ accountBalance: 1200, riskPct: 3 }), true);
    assert.deepEqual(
      { balance: (await store.get()).balance, riskPct: (await store.get()).riskPct },
      { balance: 1200, riskPct: 3 }
    );
    assert.equal(await store.importLegacy({ accountBalance: 99, riskPct: 1 }), false);
    assert.equal((await store.get()).balance, 1200);
  });

  describe('rutas /api/account-settings', () => {
    let server;
    let base;

    before(async () => {
      const app = express();
      app.use(express.json());
      registerAccountSettingsRoutes(app, { get: (...a) => store.get(...a), update: (...a) => store.update(...a) });
      await new Promise((resolve) => {
        server = app.listen(0, '127.0.0.1', resolve);
      });
      base = `http://127.0.0.1:${server.address().port}/api/account-settings`;
    });

    after(() => new Promise((resolve) => server.close(resolve)));

    const put = (body) =>
      fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    it('PUT guarda y devuelve el estado; GET lo lee', async () => {
      const res = await put({ balance: 2500, riskPct: 0.5 });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).balance, 2500);
      const got = await (await fetch(base)).json();
      assert.equal(got.balance, 2500);
      assert.equal(got.riskPct, 0.5);
    });

    it('PUT inválido → 400 con mensaje en español', async () => {
      const res = await put({ balance: 0 });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /balance debe ser un número mayor que 0/);
    });
  });
});
