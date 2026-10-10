const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const {
  isDownloadRequested,
  sanitizeDownloadName,
  contentDisposition,
  applyDownloadHeaders,
} = require('./download-headers');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

describe('isDownloadRequested', () => {
  it('acepta 1/true/yes y rechaza el resto', () => {
    assert.equal(isDownloadRequested({ download: '1' }), true);
    assert.equal(isDownloadRequested({ download: 'TRUE' }), true);
    assert.equal(isDownloadRequested({ download: ['1'] }), true);
    assert.equal(isDownloadRequested({ download: '0' }), false);
    assert.equal(isDownloadRequested({ download: '' }), false);
    assert.equal(isDownloadRequested({}), false);
    assert.equal(isDownloadRequested(undefined), false);
  });
});

describe('sanitizeDownloadName', () => {
  it('elimina rutas, traversal y caracteres peligrosos', () => {
    assert.equal(sanitizeDownloadName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeDownloadName('..\\..\\win\\system.ini'), 'system.ini');
    assert.equal(sanitizeDownloadName('a"b<c>d|e?f*.png'), 'abcdef.png');
    assert.equal(sanitizeDownloadName('bad\r\nX-Evil: 1.png'), 'badX-Evil 1.png');
    assert.equal(sanitizeDownloadName('..'), 'descarga');
    assert.equal(sanitizeDownloadName('', 'x.png'), 'x.png');
    assert.equal(sanitizeDownloadName(undefined, 'x.png'), 'x.png');
    assert.equal(sanitizeDownloadName('.hidden.png'), 'hidden.png');
  });

  it('acota la longitud conservando la extensión', () => {
    const n = sanitizeDownloadName(`${'a'.repeat(500)}.png`);
    assert.ok(n.length <= 120);
    assert.ok(n.endsWith('.png'));
  });
});

describe('contentDisposition', () => {
  it('genera attachment con filename ASCII y filename* UTF-8', () => {
    const v = contentDisposition('resultado señal.png');
    assert.match(v, /^attachment; filename="resultado se_al\.png"; filename\*=UTF-8''resultado%20se%C3%B1al\.png$/);
    assert.ok(!/[\r\n]/.test(v));
  });
});

describe('applyDownloadHeaders + sendFile (integración)', () => {
  let server;
  let port;
  let dir;
  let png;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-hdr-'));
    png = path.join(dir, 'chart.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const app = express();
    app.get('/img', (req, res) => {
      applyDownloadHeaders(req, res, 'grafico-btc.png');
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(png);
    });
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });

  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sin ?download no añade Content-Disposition', async () => {
    const r = await get(port, '/img');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-disposition'], undefined);
    assert.equal(r.headers['content-type'], 'image/png');
  });

  it('con ?download=1 usa el nombre por defecto', async () => {
    const r = await get(port, '/img?download=1');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /^attachment; filename="grafico-btc\.png"/);
    assert.deepEqual([...r.body], [0x89, 0x50, 0x4e, 0x47]);
  });

  it('?filename se sanea y no cambia el archivo servido', async () => {
    const r = await get(port, '/img?download=1&filename=..%2F..%2Fsecreto.png');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /^attachment; filename="secreto\.png"/);
    assert.deepEqual([...r.body], [0x89, 0x50, 0x4e, 0x47]);
  });
});
