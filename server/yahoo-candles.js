/**
 * Velas OHLC de Yahoo Finance (chart API) para el modo «solo Yahoo» (Android, sin MT5):
 * ATR/volatilidad en el servidor sin pasar por el puente. Misma forma que `mt5.marketRates`:
 * { symbol, timeframe, bid, ask, tickTime, rates: [{ time, open, high, low, close }] }.
 */
const TICKERS = {
  btc: ['BTC-USD'],
  us30: ['YM=F', '^DJI'],
  xauusd: ['GC=F'],
};
const FRAMES = {
  M5: { interval: '5m', range: '5d' },
  H1: { interval: '1h', range: '1mo' },
};
const TIMEOUT_MS = 10_000;

function url(ticker, { interval, range }) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
}

/** Respuesta de la chart API → velas completas (descarta huecos con null). */
function parseChart(payload) {
  const block = payload?.chart?.result?.[0];
  if (!block) throw new Error(payload?.chart?.error?.description || 'respuesta vacía de Yahoo');
  const q = block.indicators?.quote?.[0] || {};
  const rates = [];
  (block.timestamp || []).forEach((time, i) => {
    const [open, high, low, close] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if (time == null || [open, high, low, close].some((v) => v == null || !Number.isFinite(v))) return;
    rates.push({ time, open, high, low, close, volume: q.volume?.[i] || 0 });
  });
  return { rates, lastPrice: Number(block.meta?.regularMarketPrice) || null, tickTime: Number(block.meta?.regularMarketTime) || null };
}

/**
 * @param {{ market: 'btc'|'us30'|'xauusd', timeframe?: 'M5'|'H1', count?: number }} opts
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 */
async function marketRates({ market, timeframe = 'M5', count = 120 }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const tickers = TICKERS[market];
  const frame = FRAMES[String(timeframe).toUpperCase()];
  if (!tickers || !frame) throw new Error(`Yahoo: mercado/marco no soportado (${market}/${timeframe})`);
  const failures = [];
  for (const ticker of tickers) {
    try {
      const res = await fetchImpl(url(ticker, frame), {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rates, lastPrice, tickTime } = parseChart(await res.json());
      if (!rates.length) throw new Error('sin velas');
      return {
        symbol: ticker, timeframe: String(timeframe).toUpperCase(), bid: lastPrice, ask: lastPrice,
        tickTime, rates: rates.slice(-count), source: 'yahoo',
      };
    } catch (err) {
      failures.push(`${ticker}: ${err?.message || err}`);
    }
  }
  const err = new Error(`Yahoo no devolvió velas (${failures.join('; ')})`);
  err.status = 502;
  throw err;
}

module.exports = { TICKERS, FRAMES, parseChart, marketRates };
