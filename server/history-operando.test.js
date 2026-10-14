/**
 * Resultado «operando»: helpers puros + API real (index.js) sobre una DB temporal con un puente
 * MT5 falso (nunca se contacta MT5 real).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { historyIdFromKey, isRealSend, recalcAnnotation } = require('./history-operando');

describe('history-operando helpers', () => {
  it('historyIdFromKey: solo claves h<id>', () => {
    assert.equal(historyIdFromKey('h42'), 42);
    assert.equal(historyIdFromKey('rbtc1700000000'), null);
    assert.equal(historyIdFromKey('abcd1234'), null);
    assert.equal(historyIdFromKey(null), null);
  });

  it('isRealSend: enviado y sin dry-run', () => {
    assert.equal(isRealSend({ status: 'sent', result: {} }, { dry_run: false }), true);
    assert.equal(isRealSend({ status: 'sent', result: {} }, { dry_run: true }), false);
    assert.equal(isRealSend({ status: 'sent', result: { dryRun: true } }, {}), false);
    assert.equal(isRealSend({ status: 'error' }, {}), false);
    assert.equal(isRealSend({ status: 'skipped' }, {}), false);
  });

  it('recalcAnnotation: pendiente/abierta + fila vacía → operando; cierre manda', () => {
    const empty = { resultado: null };
    assert.deepEqual(recalcAnnotation(null, empty, ['pending']), { resultado: 'operando' });
    assert.deepEqual(recalcAnnotation(null, empty, ['closed', 'open']), { resultado: 'operando' });
    assert.equal(recalcAnnotation(null, empty, ['closed', undefined]), null);
    assert.equal(recalcAnnotation(null, { resultado: 'ganada' }, ['open']), null);
    assert.equal(recalcAnnotation(null, { resultado: 'operando' }, ['open']), null);
    const won = { resultado: 'ganada', pnlUsd: 5 };
    assert.equal(recalcAnnotation(won, { resultado: 'operando' }, ['closed']), won);
    const skip = { resultado: 'no_tomada' };
    assert.equal(recalcAnnotation(skip, { resultado: 'operando' }, ['expired']), skip);
  });
});

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

/** Puente MT5 falso: /order acepta (eco de dry_run), /status devuelve `bridge.status`. */
function startFakeBridge(bridge) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      bridge.calls.push({ path: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/order') {
        bridge.nextOrder += 1;
        res.end(JSON.stringify({
          ok: true,
          symbol: body.symbol,
          side: body.side,
          mode: 'limit',
          volume: 0.01,
          price: body.entry,
          sl: body.sl,
          tp: body.tp,
          order: bridge.nextOrder,
          dryRun: body.dry_run === true,
        }));
        return;
      }
      if (req.url === '/status') {
        res.end(JSON.stringify({ ok: true, volume: 0.01, ...bridge.status }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'no implementado en el puente falso' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

describe('API: Run operation → Resultado operando', () => {
  let tempDir;
  let child;
  let base;
  let bridgeServer;
  const bridge = { calls: [], nextOrder: 1000, status: { state: 'pending' } };
  const ids = {};

  async function call(method, url, body) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const resultadoOf = async (id) => (await call('GET', `/api/history/${id}`)).body.resultado;

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-operando-'));
    process.env.HISTORY_DATA_DIR = tempDir;
    const storePath = require.resolve('./db/history-store.js');
    delete require.cache[storePath];
    const store = require('./db/history-store.js');
    const snap = {
      market: 'btc',
      tier: 'high',
      status: 'done',
      summary: { verdict: 'ENTRAR_LONG', planDetails: { entry: '100', sl: '90', tp: '120' } },
    };
    for (const name of ['skipped', 'pendingRow', 'main']) {
      ({ id: ids[name] } = await store.insertSnapshot(snap));
    }
    await store.updateAnnotation(ids.skipped, { resultado: 'no_tomada' });
    store._resetForTests();
    delete require.cache[storePath];
    delete process.env.HISTORY_DATA_DIR;
    fs.writeFileSync(
      path.join(tempDir, 'mt5-sent.json'),
      JSON.stringify({ [`principal:h${ids.pendingRow}`]: { order: 555, symbol: 'BTCUSD', side: 'BUY', volume: 0.01 } }),
      'utf8'
    );

    bridgeServer = await startFakeBridge(bridge);
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
        MT5_BRIDGE_URL: `http://127.0.0.1:${bridgeServer.address().port}`,
        MT5_BRIDGE_TOKEN: '',
        MT5_SETTINGS_PATH: path.join(tempDir, 'mt5-settings.json'),
        MT5_SENT_PATH: path.join(tempDir, 'mt5-sent.json'),
        PYTHON: path.join(tempDir, 'no-python.exe'),
        ADMIN_TOKEN_SECRET: 'k'.repeat(48),
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
    await new Promise((resolve) => bridgeServer?.close(resolve) ?? resolve());
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('dry-run no marca operando', async () => {
    const res = await call('POST', '/api/mt5/push', { historyId: ids.main, dryRun: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.dryRun, true);
    assert.equal(res.body.operando, undefined);
    assert.equal(await resultadoOf(ids.main), null);
  });

  it('envío real aceptado con Resultado vacío → operando', async () => {
    const res = await call('POST', '/api/mt5/push', { historyId: ids.main });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.operando.marked, true);
    assert.equal(res.body.operando.item.resultado, 'operando');
    assert.equal(await resultadoOf(ids.main), 'operando');
  });

  it('envío real no pisa un Resultado existente', async () => {
    const res = await call('POST', '/api/mt5/push', { historyId: ids.skipped });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.operando, { marked: false, reason: 'has_resultado', resultado: 'no_tomada' });
    assert.equal(await resultadoOf(ids.skipped), 'no_tomada');
  });

  it('Recalcular: pendiente con fila vacía → operando', async () => {
    bridge.status = { state: 'pending', entry: 100, sl: 60, tp: 150 };
    const res = await call('POST', '/api/mt5/recalc', { historyId: ids.pendingRow });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.annotation, { resultado: 'operando' });
    assert.equal(res.body.capture, null);
    assert.equal(await resultadoOf(ids.pendingRow), 'operando');
  });

  it('Recalcular: abierta mantiene operando; cerrada → ganada y dispara auto captura', async () => {
    bridge.status = { state: 'open', entry: 100, sl: 60, tp: 150 };
    const open = await call('POST', '/api/mt5/recalc', { historyId: ids.main });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.annotation, null);
    assert.equal(await resultadoOf(ids.main), 'operando');

    bridge.status = { state: 'closed', entry: 100, sl: 60, tp: 150, profit: 12.5 };
    const closed = await call('POST', '/api/mt5/recalc', { historyId: ids.main });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(closed.body.annotation, { resultado: 'ganada', pnlUsd: 12.5 });
    // autoCaptureOnResult se intentó (operando → ganada); sin Python falla, pero no es null.
    assert.notEqual(closed.body.capture, null);
    const row = (await call('GET', `/api/history/${ids.main}`)).body;
    assert.equal(row.resultado, 'ganada');
    assert.equal(row.pnlUsd, 12.5);
  });

  it('Recalcular: expirada → no_tomada reemplaza operando', async () => {
    bridge.status = { state: 'expired', entry: 100, sl: 60, tp: 150 };
    const res = await call('POST', '/api/mt5/recalc', { historyId: ids.pendingRow });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await resultadoOf(ids.pendingRow), 'no_tomada');
  });
});
