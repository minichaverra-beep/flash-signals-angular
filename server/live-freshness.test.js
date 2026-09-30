/**
 * Tests de frescura live/: PNG más reciente, chart de otra corrida, velas viejas.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CHART_MAX_LAG_MS,
  pickLatestChart,
  isChartStale,
  parseDataFreshness,
} = require('./live-freshness');

describe('pickLatestChart', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-fresh-'));
    const old = path.join(dir, 'xauusd_m5_chart.png');
    const fresh = path.join(dir, 'xauusd_m5_chart_annotated.png');
    fs.writeFileSync(old, 'old');
    fs.writeFileSync(fresh, 'new');
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    fs.utimesSync(old, weekAgo, weekAgo);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('elige el PNG más reciente sin importar el orden', () => {
    const a = pickLatestChart(dir, ['xauusd_m5_chart.png', 'xauusd_m5_chart_annotated.png']);
    const b = pickLatestChart(dir, ['xauusd_m5_chart_annotated.png', 'xauusd_m5_chart.png']);
    assert.equal(a.name, 'xauusd_m5_chart_annotated.png');
    assert.equal(b.name, 'xauusd_m5_chart_annotated.png');
  });

  it('acepta un solo nombre y devuelve null si no existe', () => {
    assert.equal(pickLatestChart(dir, 'xauusd_m5_chart.png').name, 'xauusd_m5_chart.png');
    assert.equal(pickLatestChart(dir, ['nope.png']), null);
  });
});

describe('isChartStale', () => {
  it('marca chart de una corrida anterior al reporte', () => {
    const report = Date.now();
    assert.equal(isChartStale(report - 7 * 24 * 3600 * 1000, report), true);
    assert.equal(isChartStale(report - CHART_MAX_LAG_MS + 1000, report), false);
    assert.equal(isChartStale(report + 1000, report), false);
    assert.equal(isChartStale(null, report), false);
  });
});

describe('parseDataFreshness', () => {
  it('lee última vela y aviso de datos desactualizados', () => {
    const md = [
      '> Última vela M5 **2026-09-23 16:25 UTC** · hace 10070 min · fuente yfinance',
      '> ⚠️ **Datos desactualizados: última vela 2026-09-23 16:25 UTC (hace 7.0 días) — no operar**',
    ].join('\n');
    const f = parseDataFreshness(md);
    assert.equal(f.dataAsOf, '2026-09-23 16:25 UTC');
    assert.equal(f.dataStale, true);
    assert.match(f.staleMessage, /^Datos desactualizados: última vela 2026-09-23 16:25 UTC/);
  });

  it('reporte fresco o sin línea de vela', () => {
    const f = parseDataFreshness('> Última vela M5 **2026-09-30 14:05 UTC** · hace 9 min');
    assert.deepEqual(f, { dataAsOf: '2026-09-30 14:05 UTC', dataStale: false, staleMessage: null });
    assert.deepEqual(parseDataFreshness(''), { dataAsOf: null, dataStale: false, staleMessage: null });
  });
});
