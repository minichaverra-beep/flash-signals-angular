/** Errores de recursión / body inválido → JSON claro; el proceso sigue vivo. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { jsonErrorHandler, describeError, isRecursionError } = require('./error-handler');
const { cleanErrorMessage, describeScriptError } = require('./auto-capture');

function call(port, { method = 'GET', path = '/', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function recurse(n) {
  return recurse(n + 1) + 1;
}

describe('describeError', () => {
  it('reconoce el RangeError de pila y el mensaje de Python', () => {
    let err;
    try { recurse(0); } catch (e) { err = e; }
    assert.ok(err instanceof RangeError);
    assert.equal(isRecursionError(err), true);
    assert.equal(isRecursionError(new Error('maximum recursion depth exceeded')), true);
    assert.equal(isRecursionError(new Error('otra cosa')), false);
    const { status, body } = describeError(err);
    assert.equal(status, 500);
    assert.equal(body.code, 'recursion');
    assert.match(body.error, /Recursi/);
  });

  it('mapea body demasiado grande, JSON roto y errores con status', () => {
    assert.equal(describeError({ type: 'entity.too.large', status: 413 }).status, 413);
    assert.equal(describeError({ type: 'entity.parse.failed', message: 'x' }).body.code, 'bad_json');
    assert.equal(describeError(Object.assign(new Error('nope'), { status: 404 })).status, 404);
    assert.equal(describeError(new Error('boom')).body.code, 'internal');
    assert.equal(describeError(undefined).status, 500);
  });
});

describe('jsonErrorHandler en Express 5', () => {
  async function withServer(fn) {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/echo', (req, res) => res.json({ ok: true, keys: Object.keys(req.body || {}) }));
    app.get('/recursion', () => { recurse(0); });
    app.get('/async-recursion', async () => { recurse(0); });
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    app.use(jsonErrorHandler);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const origError = console.error;
    console.error = () => {};
    try {
      await fn(server.address().port);
    } finally {
      console.error = origError;
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('recursión síncrona y async → 500 JSON y el servidor sigue respondiendo', async () => {
    await withServer(async (port) => {
      for (const path of ['/recursion', '/async-recursion']) {
        const r = await call(port, { path });
        assert.equal(r.status, 500);
        assert.match(r.type, /application\/json/);
        assert.equal(JSON.parse(r.data).code, 'recursion');
      }
      assert.equal((await call(port, { path: '/ok' })).status, 200);
    });
  });

  it('JSON inválido → 400 JSON; body enorme → 413 JSON; JSON muy anidado no tumba nada', async () => {
    await withServer(async (port) => {
      const json = { 'content-type': 'application/json' };
      const bad = await call(port, { method: 'POST', path: '/echo', body: '{no es json', headers: json });
      assert.equal(bad.status, 400);
      assert.equal(JSON.parse(bad.data).code, 'bad_json');

      const big = await call(port, { method: 'POST', path: '/echo', body: JSON.stringify({ a: 'x'.repeat(5000) }), headers: json });
      assert.equal(big.status, 413);
      assert.equal(JSON.parse(big.data).code, 'too_large');

      const deep = `${'['.repeat(400)}${']'.repeat(400)}`;
      const nested = await call(port, { method: 'POST', path: '/echo', body: deep, headers: json });
      assert.match(nested.type, /application\/json/);
      assert.ok([200, 400, 500].includes(nested.status));
      assert.equal((await call(port, { path: '/ok' })).status, 200);
    });
  });
});

describe('auto-capture: mensajes de error acotados', () => {
  it('cleanErrorMessage no recursa sin fin con volcados JSON anidados', () => {
    let msg = 'fallo final';
    for (let i = 0; i < 12; i += 1) msg = JSON.stringify({ ok: false, error: msg });
    const out = cleanErrorMessage(msg);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0 && out.length <= 300);
  });

  it('el error de recursión de Python llega limpio a la UI', () => {
    const out = {
      ok: false,
      code: 'recursion',
      error: 'No se pudo dibujar el gráfico: algún texto o dato de entrada es demasiado anidado (recursión excedida).',
      detail: 'maximum recursion depth exceeded',
    };
    const r = describeScriptError(out, { python: 'python', workDir: '/tmp/w' });
    assert.match(r.error, /recursión excedida/);
    assert.doesNotMatch(r.error, /maximum recursion/);
  });
});
