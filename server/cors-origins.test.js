/** CORS: orígenes de WebView/APK (Capacitor, emulador) y extensiones de Chrome, sin abrir a `*`. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { createOriginMatcher } = require('./cors-origins');

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'; // 32 letras a-p
const OTHER_EXT = 'ponmlkjihgfedcbaponmlkjihgfedcba';

describe('createOriginMatcher', () => {
  const allowed = createOriginMatcher({});

  it('permite peticiones sin Origin y los orígenes de siempre', () => {
    for (const o of [undefined, '', 'http://localhost:4400', 'http://127.0.0.1:8080', 'http://localhost']) {
      assert.equal(allowed(o), true, String(o));
    }
  });

  it('permite WebView/APK y emulador (loopback con cualquier puerto) y apps híbridas', () => {
    for (const o of [
      'http://127.0.0.1:3847',
      'http://localhost:3847',
      'http://localhost:5173',
      'http://[::1]:3847',
      'https://localhost',
      'https://localhost:8443',
      'http://10.0.2.2:3847',
      'capacitor://localhost',
      'ionic://localhost',
    ]) {
      assert.equal(allowed(o), true, o);
    }
  });

  it('rechaza orígenes ajenos, puertos inválidos y trucos de subdominio', () => {
    for (const o of [
      'https://evil.example',
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example:3847',
      'http://localhost:99999',
      'http://localhost:0',
      'http://localhost:3847/path',
      'capacitor://evil',
      'null',
      '*',
      `http://localhost:${'1'.repeat(300)}`,
    ]) {
      assert.equal(allowed(o), false, o.slice(0, 60));
    }
  });

  it('extensiones de Chrome: bloqueadas por defecto', () => {
    assert.equal(allowed(`chrome-extension://${EXT_ID}`), false);
  });

  it('extensiones de Chrome: solo los ids de CORS_EXTENSION_IDS', () => {
    const m = createOriginMatcher({ CORS_EXTENSION_IDS: ` ${EXT_ID} , no-es-un-id ` });
    assert.equal(m(`chrome-extension://${EXT_ID}`), true);
    assert.equal(m(`chrome-extension://${OTHER_EXT}`), false);
    assert.equal(m('chrome-extension://no-es-un-id'), false);
    assert.equal(m(`chrome-extension://${EXT_ID}/pagina`), false);
  });

  it('CORS_ALLOW_ANY_EXTENSION=1 acepta cualquier id válido, no cualquier esquema', () => {
    const m = createOriginMatcher({ CORS_ALLOW_ANY_EXTENSION: '1' });
    assert.equal(m(`chrome-extension://${OTHER_EXT}`), true);
    assert.equal(m('chrome-extension://corto'), false);
    assert.equal(m('moz-extension://abc'), false);
  });

  it('CORS_ORIGINS añade orígenes exactos', () => {
    const m = createOriginMatcher({ CORS_ORIGINS: 'https://mi.app, http://192.168.1.50:8080' });
    assert.equal(m('https://mi.app'), true);
    assert.equal(m('http://192.168.1.50:8080'), true);
    assert.equal(m('http://192.168.1.51:8080'), false);
  });
});

describe('cors con el matcher (cabeceras reales)', () => {
  function request(port, origin) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/ping', headers: origin ? { Origin: origin } : {} }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers['access-control-allow-origin'] ?? null));
      });
      req.on('error', reject);
    });
  }

  it('devuelve Access-Control-Allow-Origin solo para orígenes permitidos', async () => {
    const isOriginAllowed = createOriginMatcher({ CORS_EXTENSION_IDS: EXT_ID });
    const app = express();
    app.use(cors({ origin: (origin, cb) => cb(null, isOriginAllowed(origin)) }));
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = server.address();
      assert.equal(await request(port, 'capacitor://localhost'), 'capacitor://localhost');
      assert.equal(await request(port, 'http://localhost:3847'), 'http://localhost:3847');
      assert.equal(await request(port, `chrome-extension://${EXT_ID}`), `chrome-extension://${EXT_ID}`);
      assert.equal(await request(port, `chrome-extension://${OTHER_EXT}`), null);
      assert.equal(await request(port, 'https://evil.example'), null);
      assert.equal(await request(port), null); // sin Origin: sin cabecera CORS, la respuesta funciona igual
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
