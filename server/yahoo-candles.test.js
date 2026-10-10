const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { marketRates, parseChart } = require('./yahoo-candles');

const chart = (n, extra = {}) => ({
  chart: {
    result: [{
      meta: { regularMarketPrice: 100.5, regularMarketTime: 1_790_000_000 },
      timestamp: Array.from({ length: n }, (_, i) => 1_789_000_000 + i * 300),
      indicators: { quote: [{
        open: Array(n).fill(100), high: Array(n).fill(101), low: Array(n).fill(99), close: Array(n).fill(100.5),
        volume: Array(n).fill(7), ...extra,
      }] },
    }],
  },
});

const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

describe('yahoo-candles', () => {
  it('parseChart descarta velas con huecos (null)', () => {
    const { rates } = parseChart(chart(3, { close: [1, null, 3], open: [1, 1, 1], high: [2, 2, 2], low: [0, 0, 0] }));
    assert.equal(rates.length, 2);
  });

  it('marketRates devuelve la forma del puente y recorta a count', async () => {
    const r = await marketRates({ market: 'xauusd', timeframe: 'M5', count: 5 }, { fetchImpl: ok(chart(20)) });
    assert.equal(r.symbol, 'GC=F');
    assert.equal(r.rates.length, 5);
    assert.deepEqual(Object.keys(r.rates[0]).sort(), ['close', 'high', 'low', 'open', 'time', 'volume']);
    assert.equal(r.source, 'yahoo');
  });

  it('us30 cae de YM=F a ^DJI y nunca toca el puente', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(decodeURIComponent(url));
      if (urls.length === 1) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => chart(10) };
    };
    const r = await marketRates({ market: 'us30', timeframe: 'H1' }, { fetchImpl });
    assert.equal(r.symbol, '^DJI');
    assert.match(urls[0], /YM=F.*interval=1h/);
    assert.ok(urls.every((u) => u.includes('finance.yahoo.com')));
  });

  it('si Yahoo falla da 502 con el detalle por ticker', async () => {
    const fetchImpl = async () => { throw new Error('sin red'); };
    await assert.rejects(marketRates({ market: 'btc' }, { fetchImpl }), (err) => {
      assert.equal(err.status, 502);
      assert.match(err.message, /BTC-USD: sin red/);
      return true;
    });
  });

  it('mercado o marco no soportado', async () => {
    await assert.rejects(marketRates({ market: 'eurusd' }, { fetchImpl: ok(chart(1)) }), /no soportado/);
    await assert.rejects(marketRates({ market: 'btc', timeframe: 'D1' }, { fetchImpl: ok(chart(1)) }), /no soportado/);
  });
});
