/**
 * El motor ya no sale de D:\Danilo\Trading\Cursor Trading: se pide al endpoint.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { explicitRoot, ensureTradingRoot, installTree, LEGACY_TRADING_ROOT } = require('./trading-source');

test('la ruta local vieja no cuenta como origen', () => {
  assert.equal(explicitRoot({ CURSOR_TRADING_ROOT: LEGACY_TRADING_ROOT }), null);
  assert.equal(explicitRoot({ CURSOR_TRADING_ROOT: '' }), null);
});

test('CURSOR_TRADING_LOCAL=1 sí usa la ruta vieja', () => {
  const root = explicitRoot({
    CURSOR_TRADING_ROOT: LEGACY_TRADING_ROOT,
    CURSOR_TRADING_LOCAL: '1',
  });
  assert.equal(path.normalize(root).toLowerCase(), path.normalize(LEGACY_TRADING_ROOT).toLowerCase());
});

test('otra ruta explícita que ya tiene analyze.sh no llama al endpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-local-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'analyze'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'analyze', 'analyze.sh'), '#!/bin/sh\n');
  let called = false;
  const info = await ensureTradingRoot({
    env: { CURSOR_TRADING_ROOT: dir },
    fetchImpl: async () => {
      called = true;
      throw new Error('no debía pedir el endpoint');
    },
  });
  assert.equal(called, false);
  assert.equal(info.source, 'local');
  assert.equal(info.root, path.resolve(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('si el sha de la caché coincide, no vuelve a bajar el tarball', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-cache-'));
  fs.mkdirSync(path.join(cache, 'scripts', 'analyze'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'scripts', 'analyze', 'analyze.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(cache, '.source-sha'), 'abc123\n');
  let downloads = 0;
  const info = await ensureTradingRoot({
    env: { CURSOR_TRADING_CACHE: cache, CURSOR_TRADING_COMMIT_URL: 'https://example.test/commit' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ sha: 'abc123' }) }),
    download: async () => {
      downloads += 1;
    },
  });
  assert.equal(downloads, 0);
  assert.equal(info.source, 'endpoint');
  assert.equal(info.sha, 'abc123');
  assert.equal(info.root, path.resolve(cache));
  fs.rmSync(cache, { recursive: true, force: true });
});

test('sha nuevo descarga y conserva live/ ya escrito', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-cache-'));
  fs.mkdirSync(path.join(cache, 'live'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'live', 'mio.md'), 'local');
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-extract-'));
  fs.mkdirSync(path.join(extracted, 'scripts', 'analyze'), { recursive: true });
  fs.writeFileSync(path.join(extracted, 'scripts', 'analyze', 'analyze.sh'), '#!/bin/sh\n');
  fs.mkdirSync(path.join(extracted, 'live'), { recursive: true });
  fs.writeFileSync(path.join(extracted, 'live', 'mio.md'), 'remoto');
  fs.writeFileSync(path.join(extracted, 'app.txt'), 'ok');

  const info = await ensureTradingRoot({
    env: { CURSOR_TRADING_CACHE: cache },
    fetchImpl: async () => ({ ok: true, json: async () => ({ sha: 'nuevo' }) }),
    download: async () => {},
    extract: async () => extracted,
  });

  assert.equal(info.source, 'endpoint');
  assert.equal(info.sha, 'nuevo');
  assert.equal(fs.readFileSync(path.join(cache, 'live', 'mio.md'), 'utf8'), 'local');
  assert.equal(fs.readFileSync(path.join(cache, 'app.txt'), 'utf8'), 'ok');
  assert.equal(fs.readFileSync(path.join(cache, '.source-sha'), 'utf8').trim(), 'nuevo');
  fs.rmSync(cache, { recursive: true, force: true });
  fs.rmSync(extracted, { recursive: true, force: true });
});

test('installTree no pisa live existente', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-inst-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-src-'));
  fs.mkdirSync(path.join(cache, 'live'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'live', 'keep.txt'), 'si');
  fs.mkdirSync(path.join(src, 'live'), { recursive: true });
  fs.writeFileSync(path.join(src, 'live', 'keep.txt'), 'no');
  fs.writeFileSync(path.join(src, 'nuevo.txt'), '1');
  installTree(src, cache);
  assert.equal(fs.readFileSync(path.join(cache, 'live', 'keep.txt'), 'utf8'), 'si');
  assert.equal(fs.readFileSync(path.join(cache, 'nuevo.txt'), 'utf8'), '1');
  fs.rmSync(cache, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});
