/**
 * Login admin: unidad (hash / token / rate-limit) + HTTP real (index.js) sobre data temporal.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createAdminAuth, hashPassword, parseHash, verifyPassword } = require('./auth');

const quietLogger = { warn() {}, log() {} };

describe('auth (unidad)', () => {
  it('hash scrypt verifica la contraseña correcta y rechaza otra', () => {
    const parsed = parseHash(hashPassword('s3cret'));
    assert.ok(parsed);
    assert.equal(verifyPassword('s3cret', parsed), true);
    assert.equal(verifyPassword('otra', parsed), false);
    assert.equal(parseHash('texto-plano'), null);
  });

  it('sin env usa admin/admin y avisa en consola', () => {
    const warnings = [];
    const auth = createAdminAuth({
      env: { ADMIN_TOKEN_SECRET: 'x'.repeat(40) },
      logger: { warn: (m) => warnings.push(m), log() {} },
    });
    assert.equal(auth.username, 'admin');
    assert.equal(auth.usingDefaultPassword, true);
    assert.ok(warnings.some((w) => /contraseña por defecto/.test(w)));
  });

  it('token firmado: válido, manipulado y caducado', () => {
    let t = 1_000_000;
    const auth = createAdminAuth({
      env: { ADMIN_PASSWORD: 'p', ADMIN_TOKEN_SECRET: 'y'.repeat(40), ADMIN_TOKEN_TTL_HOURS: '1' },
      logger: quietLogger,
      now: () => t,
    });
    const { token } = auth.issueToken();
    assert.equal(auth.verifyToken(token)?.sub, 'admin');
    assert.equal(auth.verifyToken(`${token}x`), null);
    assert.equal(auth.verifyToken('basura'), null);
    t += 3_600_001;
    assert.equal(auth.verifyToken(token), null);
  });

  it('otro secreto no acepta el token', () => {
    const env = { ADMIN_PASSWORD: 'p' };
    const a = createAdminAuth({ env: { ...env, ADMIN_TOKEN_SECRET: 'a'.repeat(40) }, logger: quietLogger });
    const b = createAdminAuth({ env: { ...env, ADMIN_TOKEN_SECRET: 'b'.repeat(40) }, logger: quietLogger });
    assert.equal(b.verifyToken(a.issueToken().token), null);
  });

  it('sin ADMIN_TOKEN_SECRET persiste el secreto en dataDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-auth-secret-'));
    try {
      const a = createAdminAuth({ env: { ADMIN_PASSWORD: 'p' }, dataDir: dir, logger: quietLogger });
      const b = createAdminAuth({ env: { ADMIN_PASSWORD: 'p' }, dataDir: dir, logger: quietLogger });
      assert.ok(fs.existsSync(path.join(dir, 'admin-token-secret')));
      assert.equal(b.verifyToken(a.issueToken().token)?.sub, 'admin');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe('API /api/auth + endpoints protegidos', () => {
  let tempDir;
  let child;
  let base;

  async function call(method, url, body, headers = {}) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const login = (password) => call('POST', '/api/auth/login', { username: 'admin', password });

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-auth-'));
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
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD: 'test-admin',
        ADMIN_PASSWORD_HASH: '',
        ADMIN_TOKEN_SECRET: 'z'.repeat(48),
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

  it('login ok devuelve token y /me lo reconoce; logout lo revoca', async () => {
    const ok = await login('test-admin');
    assert.equal(ok.status, 200);
    assert.equal(typeof ok.body.token, 'string');
    const auth = { Authorization: `Bearer ${ok.body.token}` };

    const me = await call('GET', '/api/auth/me', undefined, auth);
    assert.equal(me.status, 200);
    assert.equal(me.body.authenticated, true);
    assert.equal(me.body.user.username, 'admin');

    assert.equal((await call('POST', '/api/auth/logout', undefined, auth)).status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, auth)).status, 401);
  });

  it('/me sin token → 200 authenticated:false; token falso → 401', async () => {
    const anon = await call('GET', '/api/auth/me');
    assert.equal(anon.status, 200);
    assert.equal(anon.body.authenticated, false);
    assert.equal((await call('GET', '/api/auth/me', undefined, { Authorization: 'Bearer x.y' })).status, 401);
  });

  it('endpoint protegido: 401 sin token, 2xx con token; lectura sigue pública', async () => {
    assert.equal((await call('GET', '/api/wiki/categories')).status, 200);

    const anon = await call('POST', '/api/wiki/categories', { name: 'Sin login' });
    assert.equal(anon.status, 401);
    assert.equal(anon.body.code, 'admin_required');
    assert.equal((await call('DELETE', '/api/history')).status, 401);
    assert.equal((await call('PATCH', '/api/artifacts/meta', { path: 'x.md' })).status, 401);

    const { body } = await login('test-admin');
    const auth = { Authorization: `Bearer ${body.token}` };
    const created = await call('POST', '/api/wiki/categories', { name: 'Admin cat' }, auth);
    assert.equal(created.status, 201);
    const del = await call('DELETE', `/api/wiki/categories/${created.body.category.id}`, undefined, auth);
    assert.equal(del.status, 200);
  });

  it('login fallido → 401 y tras 5 fallos → 429', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await login('mala');
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'Usuario o contraseña incorrectos');
    }
    const blocked = await login('test-admin');
    assert.equal(blocked.status, 429);
  });
});
