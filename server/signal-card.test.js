const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');
const { applyDownloadHeaders } = require('./download-headers');
const card = require('./signal-card');

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Sustituto de `spawn`: escribe el PNG pedido y responde con el JSON del compositor. */
function fakeSpawn({ ok = true, chart = true, chartError = null, writeFile = true, exitCode = 0 } = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const out = args[args.indexOf('--out') + 1];
    const specPath = args[args.indexOf('--spec') + 1];
    setImmediate(() => {
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      calls[calls.length - 1].spec = spec;
      if (writeFile) fs.writeFileSync(out, Buffer.concat([PNG_HEADER, Buffer.alloc(64, 1)]));
      if (ok) {
        child.stdout.emit('data', JSON.stringify({ ok: true, path: out, chart, chart_error: chartError }) + '\n');
      } else {
        child.stderr.emit('data', 'Traceback...\nRuntimeError: sin Pillow\n');
      }
      child.emit('close', exitCode);
    });
    return child;
  };
  impl.calls = calls;
  return impl;
}

function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port, method, path: p,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const FULL_CARD = {
  symbol: 'btc', timeframe: 'M5', tier: 'HIGH', price: '81319.7', direction: 'Alcista',
  odds: { compra: 65, venta: 35 },
  pills: [{ kicker: 'Tendencia / sesgo', title: 'Alcista' }],
  action: { state: 'ESPERAR', reason: 'Tokio · Sídney' },
  levels: [{ label: 'Entrada', value: '81318.3', tone: 'text' }, { label: 'SL', value: '81258.3', tone: 'loss' }],
  primary: { title: 'Escenario alcista', tone: 'gain', bullets: ['Veredicto: No operar'] },
  pullback: null, footer: null, risk: 60, riskFill: 55, riskNote: 'nota',
};

describe('sanitizeCardSpec', () => {
  it('acota textos, descarta direcciones/acciones inválidas y conserva lo real', () => {
    const spec = card.sanitizeCardSpec({
      ...FULL_CARD,
      direction: 'Lateral',
      action: { state: 'YOLO' },
      footer: 'x'.repeat(1000),
      pills: Array.from({ length: 30 }, (_, i) => ({ kicker: 'k', title: `p${i}` })),
      levels: [{ label: 'TP', value: '  ' }, { label: 'SL', value: '1', tone: 'weird' }],
    });
    assert.equal(spec.symbol, 'BTC');
    assert.equal(spec.direction, null);
    assert.equal(spec.action, null);
    assert.equal(spec.footer.length, card.MAX_TEXT);
    assert.equal(spec.pills.length, card.MAX_ITEMS);
    assert.deepEqual(spec.levels, [{ label: 'SL', value: '1', tone: 'text' }]);
    assert.deepEqual(spec.odds, { compra: 65, venta: 35 });
    assert.equal(spec.risk, 60);
    assert.equal(card.specHasContent(spec), true);
  });

  it('una tarjeta vacía no tiene contenido', () => {
    assert.equal(card.specHasContent(card.sanitizeCardSpec({})), false);
    assert.equal(card.specHasContent(card.sanitizeCardSpec(null)), false);
  });

  it('quita caracteres de control (no viajan al script)', () => {
    const spec = card.sanitizeCardSpec({ symbol: 'bt\u0000c\u001b' });
    assert.equal(spec.symbol, 'BTC');
  });
});

describe('parseScriptOutput', () => {
  it('lee la última línea JSON de stdout', () => {
    const out = card.parseScriptOutput('WARN algo\n{"ok": true, "chart": false}\n', '', 0);
    assert.deepEqual(out, { ok: true, chart: false });
  });
  it('sin JSON usa la última línea de stderr', () => {
    const out = card.parseScriptOutput('', 'Traceback\nModuleNotFoundError: PIL\n', 1);
    assert.equal(out.ok, false);
    assert.match(out.error, /ModuleNotFoundError/);
  });
});

describe('composeSignalCard', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-card-test-')); });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('lanza el compositor con el spec saneado y la ruta del PNG de live/', async () => {
    const spawnImpl = fakeSpawn();
    const outPath = path.join(tmp, 'cards', 'btc_signal_card.png');
    const res = await card.composeSignalCard({
      py: 'python', tradingRoot: tmp, spec: FULL_CARD, chartPath: 'C:/live/btc.png', outPath, spawnImpl,
    });
    assert.equal(res.ok, true);
    assert.equal(res.chart, true);
    assert.ok(fs.existsSync(outPath));
    const call = spawnImpl.calls[0];
    assert.deepEqual(call.args.slice(0, 2), ['-m', 'app.views.signal_card']);
    assert.equal(call.opts.cwd, tmp);
    assert.equal(call.spec.chart, 'C:/live/btc.png');
    assert.equal(call.spec.symbol, 'BTC');
    assert.equal(call.spec.action.state, 'ESPERAR');
  });

  it('sin PNG de live/ la tarjeta sale sin gráfico y lo dice', async () => {
    const spawnImpl = fakeSpawn({ chart: false, chartError: 'PNG no encontrado: btc.png' });
    const res = await card.composeSignalCard({
      py: 'python', tradingRoot: tmp, spec: FULL_CARD, chartPath: null, outPath: path.join(tmp, 'a.png'), spawnImpl,
    });
    assert.equal(res.ok, true);
    assert.equal(res.chart, false);
    assert.equal(res.chartError, 'PNG no encontrado: btc.png');
    assert.equal(spawnImpl.calls[0].spec.chart, null);
  });

  it('error de Python → ok:false con el motivo (stderr)', async () => {
    const res = await card.composeSignalCard({
      py: 'python', tradingRoot: tmp, spec: FULL_CARD, outPath: path.join(tmp, 'b.png'),
      spawnImpl: fakeSpawn({ ok: false, writeFile: false, exitCode: 1 }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /sin Pillow/);
  });

  it('tarjeta vacía → no se lanza nada', async () => {
    const spawnImpl = fakeSpawn();
    const res = await card.composeSignalCard({ tradingRoot: tmp, spec: {}, outPath: path.join(tmp, 'c.png'), spawnImpl });
    assert.equal(res.ok, false);
    assert.equal(spawnImpl.calls.length, 0);
  });
});

describe('rutas /api/signals/card', () => {
  let server;
  let port;
  let dataDir;
  const prevData = process.env.HISTORY_DATA_DIR;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-card-data-'));
    process.env.HISTORY_DATA_DIR = dataDir;
    const app = express();
    app.use(express.json());
    const spawnImpl = fakeSpawn();
    // Misma lógica que index.js, con el compositor simulado.
    app.post('/api/signals/card', async (req, res) => {
      const market = String(req.body.market || '').toLowerCase();
      if (!['btc', 'us30', 'xauusd'].includes(market)) return res.status(400).json({ error: 'market' });
      const spec = card.sanitizeCardSpec(req.body.card);
      if (!card.specHasContent(spec)) return res.status(400).json({ error: 'La tarjeta no trae datos que pintar' });
      const outPath = path.join(card.cardsDir(), card.cardFileName(market));
      const result = await card.composeSignalCard({ tradingRoot: dataDir, spec, chartPath: null, outPath, spawnImpl });
      if (!result.ok) return res.status(500).json({ error: result.error });
      res.json({ ok: true, cardUrl: card.cardUrl(market, fs.statSync(outPath).mtimeMs), chart: result.chart });
    });
    app.get('/api/signals/card', (req, res) => {
      const market = String(req.query.market || 'btc').toLowerCase();
      const file = card.latestCardFile(market);
      if (!file) return res.status(404).json({ error: 'Aún no hay tarjeta compuesta para este mercado.' });
      res.setHeader('Content-Type', 'image/png');
      applyDownloadHeaders(req, res, `senal-${market}.png`);
      res.sendFile(file.full);
    });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    if (prevData === undefined) delete process.env.HISTORY_DATA_DIR;
    else process.env.HISTORY_DATA_DIR = prevData;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET sin tarjeta → 404 JSON en español', async () => {
    const res = await request(port, 'GET', '/api/signals/card?market=btc');
    assert.equal(res.status, 404);
    assert.match(JSON.parse(res.body.toString()).error, /Aún no hay tarjeta/);
  });

  it('POST compone, GET sirve el PNG y ?download=1 añade Content-Disposition', async () => {
    const post = await request(port, 'POST', '/api/signals/card', { market: 'btc', card: FULL_CARD });
    assert.equal(post.status, 200);
    const body = JSON.parse(post.body.toString());
    assert.equal(body.ok, true);
    assert.match(body.cardUrl, /^\/api\/signals\/card\?market=btc&v=\d+$/);

    const get = await request(port, 'GET', body.cardUrl);
    assert.equal(get.status, 200);
    assert.equal(get.headers['content-type'], 'image/png');
    assert.equal(get.headers['content-disposition'], undefined);
    assert.ok(get.body.subarray(0, 8).equals(PNG_HEADER));

    const dl = await request(port, 'GET', `${body.cardUrl}&download=1&filename=${encodeURIComponent('../mi senal.png')}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers['content-disposition'], /^attachment; filename="mi senal.png"/);
  });

  it('POST con tarjeta vacía → 400', async () => {
    const res = await request(port, 'POST', '/api/signals/card', { market: 'btc', card: {} });
    assert.equal(res.status, 400);
  });
});
