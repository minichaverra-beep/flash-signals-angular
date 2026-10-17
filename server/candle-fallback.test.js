const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { marketRates } = require('./yahoo-candles');
const { sourcesFor, parseStooq, fallbackAfterYahoo } = require('./candle-fallback');

const klines = (n = 4) => Array.from({ length: n }, (_, i) => (
  [1_700_000_000_000 + i * 300_000, '100', '102', '99', String(100 + i), '3']
));

const okJson = (body) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

describe('candle-fallback', () => {
  it('mapea BTC, oro y Dow sin inventar US30 en Binance ni OKX', () => {
    assert.equal(sourcesFor('btc')[0].symbol, 'BTCUSDT');
    assert.equal(sourcesFor('btc')[1].symbol, 'BTC-USDT');
    const xau = sourcesFor('xauusd');
    assert.equal(xau[0].kind, 'binance-futures');
    assert.equal(xau[0].symbol, 'XAUUSDT');
    assert.equal(xau[1].symbol, 'XAU-USDT-SWAP');
    const us = sourcesFor('us30');
    assert.equal(us[0].symbol, null);
    assert.match(us[0].skip, /no lista US30/);
    assert.equal(us[1].symbol, null);
    assert.equal(us[2].symbol, '^dji');
    assert.ok(us.every((s) => !s.symbol || !s.symbol.toUpperCase().includes('BTC')));
  });

  it('Stooq HTML no cuenta como velas', () => {
    assert.throws(() => parseStooq('<html>verify your browser</html>'), /HTML/);
  });

  it('si Yahoo falla, BTC usa Binance y no repite la petición', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes('finance.yahoo.com')) throw new Error('yahoo caido');
      if (url.includes('api.binance.com/api/v3/klines') && url.includes('symbol=BTCUSDT')) {
        return { ok: true, status: 200, json: async () => klines(), text: async () => '' };
      }
      throw new Error(`no debía pedir ${url}`);
    };
    const r = await marketRates({ market: 'btc', timeframe: 'M5', count: 3 }, { fetchImpl });
    assert.equal(r.source, 'binance');
    assert.match(r.sourceLabel, /Binance \(Yahoo falló\)/);
    assert.equal(r.symbol, 'BTCUSDT');
    assert.equal(r.rates.length, 3);
    assert.equal(urls.filter((u) => u.includes('api.binance.com')).length, 1);
    assert.ok(urls.every((u) => !u.includes('8765') && !u.includes('8766')));
  });

  it('US30 no pide BTC: tras Yahoo salta a Stooq', async () => {
    const urls = [];
    const csv = 'Date,Time,Open,High,Low,Close,Volume\n2026-10-01,16:00:00,42000,42100,41900,42050,1\n2026-10-01,16:05:00,42050,42200,42000,42100,1\n';
    const fetchImpl = async (url) => {
      urls.push(url);
      assert.ok(!url.toUpperCase().includes('BTC'));
      assert.ok(!url.includes('binance.com') && !url.includes('okx.com'));
      if (url.includes('finance.yahoo.com')) return { ok: false, status: 502, json: async () => ({}), text: async () => '' };
      if (url.includes('stooq.com') && url.includes('%5Edji')) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => csv };
      }
      throw new Error(url);
    };
    const r = await marketRates({ market: 'us30', timeframe: 'M5', count: 2 }, { fetchImpl });
    assert.equal(r.source, 'stooq');
    assert.match(r.sourceLabel, /Stooq \(Yahoo falló\)/);
    assert.equal(r.symbol, '^dji');
  });

  it('si todas fallan, el error en español lista las fuentes', async () => {
    const fetchImpl = async () => { throw new Error('timeout'); };
    await assert.rejects(
      fallbackAfterYahoo({ market: 'us30', timeframe: 'M5', count: 10, failures: ['YM=F: timeout (query1)'], fetchImpl }),
      (err) => {
        assert.equal(err.status, 502);
        assert.match(err.message, /Fuentes probadas/);
        assert.match(err.message, /Binance/);
        assert.match(err.message, /OKX/);
        assert.match(err.message, /Stooq/);
        assert.doesNotMatch(err.message, /BTCUSDT/);
        return true;
      },
    );
  });

  it('okJson de Binance se puede leer', async () => {
    const fetchImpl = okJson(klines(2));
    const r = await fallbackAfterYahoo({
      market: 'btc', timeframe: 'H1', count: 2, failures: ['Yahoo'], fetchImpl,
    });
    assert.equal(r.timeframe, 'H1');
    assert.match(r.symbol, /BTCUSDT/);
  });
});
