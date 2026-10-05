/**
 * Candado por fila (HTTP): el API real (index.js) sobre una DB temporal.
 * Una fila bloqueada rechaza con 423 cualquier cambio; desbloquear siempre se permite.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PASSWORD = 'test-unlock';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`API no arrancó:\n${out}`)), 20_000);
    const onData = (d) => {
      out += d;
      if (out.includes('Flash Signals API →')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`API terminó (${code}):\n${out}`));
    });
  });
}

describe('API /api/history/:id con candado', () => {
  let tempDir;
  let child;
  let base;
  let id;
  let pastId;

  async function call(method, url, body, headers = {}) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-lock-'));
    process.env.HISTORY_DATA_DIR = tempDir;
    const storePath = require.resolve('./db/history-store.js');
    delete require.cache[storePath];
    const store = require('./db/history-store.js');
    const snap = {
      market: 'btc',
      tier: 'high',
      status: 'done',
      summary: { verdict: 'OPERAR_LONG', planDetails: { entry: '100', sl: '90', tp: '120' } },
    };
    ({ id } = await store.insertSnapshot(snap));
    store._setClockForTests(() => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
    ({ id: pastId } = await store.insertSnapshot(snap));
    store._setClockForTests(null);
    store._resetForTests();
    delete require.cache[storePath];
    delete process.env.HISTORY_DATA_DIR;
    const sent = {};
    for (const profile of ['principal', 'secundaria']) {
      sent[`${profile}:h${pastId}`] = { order: 555, symbol: 'BTCUSD', side: 'BUY', volume: 0.01 };
    }
    fs.writeFileSync(path.join(tempDir, 'mt5-sent.json'), JSON.stringify(sent), 'utf8');

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
      cwd: __dirname,
      env: {
        ...process.env,
        PORT: String(port),
        BIND_HOST: '127.0.0.1',
        HISTORY_DATA_DIR: tempDir,
        CURSOR_TRADING_ROOT: tempDir,
        HISTORY_UNLOCK_PASSWORD: PASSWORD,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForListening(child);
  });

  after(async () => {
    if (child && child.exitCode == null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('bloquea, rechaza mutaciones con 423 y desbloquea', async () => {
    const lock = await call('PATCH', `/api/history/${id}`, { locked: true });
    assert.equal(lock.status, 200);
    assert.equal(lock.body.item.locked, true);
    assert.equal((await call('GET', `/api/history/${id}`)).body.locked, true);

    const rejected = [
      await call('PATCH', `/api/history/${id}`, { comment: 'x' }),
      await call('PATCH', `/api/history/${id}`, { resultado: 'ganada', pnlUsd: 10 }),
      await call('PATCH', `/api/history/${id}`, { tagIds: [] }),
      await call('PATCH', `/api/history/${id}`, { confluenceIds: [] }),
      await call('POST', `/api/history/${id}/result-image`, {
        imageBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        mime: 'image/png',
      }),
      await call('DELETE', `/api/history/${id}/result-image`),
      await call('POST', `/api/history/${id}/auto-capture`, {}),
      await call('POST', `/api/history/${id}/mt5-pnl`, {}),
      await call('DELETE', `/api/history/${id}`, undefined, { 'X-History-Unlock': PASSWORD }),
    ];
    for (const r of rejected) {
      assert.equal(r.status, 423);
      assert.equal(r.body.error, 'La fila está bloqueada');
    }

    const mixed = await call('PATCH', `/api/history/${id}`, { locked: false, comment: 'x' });
    assert.equal(mixed.status, 400);

    const unlock = await call('PATCH', `/api/history/${id}`, { locked: false });
    assert.equal(unlock.status, 200);
    assert.equal(unlock.body.item.locked, false);

    const edit = await call('PATCH', `/api/history/${id}`, { comment: 'ok' });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.item.comment, 'ok');
  });

  it('fila de un día anterior: 423 hasta desbloquearla; re-bloquear limpia el override', async () => {
    const before = await call('GET', `/api/history/${pastId}`);
    assert.equal(before.body.autoLocked, true);
    assert.equal(before.body.effectiveLocked, true);
    assert.equal(before.body.locked, false);

    for (const r of [
      await call('PATCH', `/api/history/${pastId}`, { comment: 'x' }),
      await call('POST', `/api/history/${pastId}/auto-capture`, {}),
      await call('POST', `/api/history/${pastId}/mt5-pnl`, {}),
      await call('DELETE', `/api/history/${pastId}/result-image`),
    ]) {
      assert.equal(r.status, 423);
    }

    const unlock = await call('PATCH', `/api/history/${pastId}`, { locked: false });
    assert.equal(unlock.status, 200);
    assert.equal(unlock.body.item.unlockOverride, true);
    assert.equal(unlock.body.item.effectiveLocked, false);
    assert.equal((await call('PATCH', `/api/history/${pastId}`, { comment: 'ok' })).status, 200);

    const relock = await call('PATCH', `/api/history/${pastId}`, { locked: true });
    assert.equal(relock.body.item.unlockOverride, false);
    assert.equal(relock.body.item.effectiveLocked, true);
    assert.equal((await call('PATCH', `/api/history/${pastId}`, { comment: 'no' })).status, 423);

    const list = await call('GET', '/api/history?pageSize=10');
    assert.equal(typeof list.body.lockTz, 'string');
    assert.equal(list.body.items.find((i) => i.id === id).autoLocked, false);
  });

  it('recálculos no alteran filas bloqueadas: Recalcular MT5 → 423, Actualizar Probabilidad las omite', async () => {
    const prev = await call('GET', `/api/history/${pastId}`);
    assert.equal(prev.body.effectiveLocked, true);

    const mt5Recalc = await call('POST', '/api/mt5/recalc', { historyId: pastId });
    assert.equal(mt5Recalc.status, 423);

    const bulk = await call('POST', '/api/history/recalc-probabilidad', { force: true });
    assert.equal(bulk.status, 200);
    assert.ok(bulk.body.skippedLocked >= 1);

    const next = await call('GET', `/api/history/${pastId}`);
    assert.deepEqual(next.body.summary, prev.body.summary);
    assert.equal(next.body.scoreCombined, prev.body.scoreCombined);
  });

  it('locked no booleano → 400; id inexistente → 404', async () => {
    assert.equal((await call('PATCH', `/api/history/${id}`, { locked: 'si' })).status, 400);
    assert.equal((await call('PATCH', '/api/history/99999', { locked: true })).status, 404);
  });
});
