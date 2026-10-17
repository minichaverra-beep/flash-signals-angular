/**
 * Si Yahoo no devuelve velas: Binance → OKX → Stooq (y Gate/Coinbase al final).
 * Sin MT5. US30 no usa símbolos de BTC. Cada fetch corta a los 10 s.
 */
const TIMEOUT_MS = 10_000;

const PRETTY = {
  binance: 'Binance (Yahoo falló)',
  okx: 'OKX (Yahoo falló)',
  stooq: 'Stooq (Yahoo falló)',
  gate: 'Gate.io (Yahoo falló)',
  coinbase: 'Coinbase (Yahoo falló)',
};

/** @type {Record<string, Array<{ provider: string, symbol: string|null, kind: string, skip?: string }>>} */
const CHAINS = {
  btc: [
    { provider: 'binance', symbol: 'BTCUSDT', kind: 'binance-spot' },
    { provider: 'okx', symbol: 'BTC-USDT', kind: 'okx' },
    { provider: 'stooq', symbol: 'btcusd', kind: 'stooq' },
    { provider: 'coinbase', symbol: 'BTC-USD', kind: 'coinbase' },
  ],
  xauusd: [
    { provider: 'binance', symbol: 'XAUUSDT', kind: 'binance-futures' },
    { provider: 'okx', symbol: 'XAU-USDT-SWAP', kind: 'okx' },
    { provider: 'stooq', symbol: 'xauusd', kind: 'stooq' },
    { provider: 'gate', symbol: 'XAU_USDT', kind: 'gate' },
  ],
  us30: [
    { provider: 'binance', symbol: null, kind: '', skip: 'omitido: Binance no lista US30' },
    { provider: 'okx', symbol: null, kind: '', skip: 'omitido: OKX no lista el Dow' },
    { provider: 'stooq', symbol: '^dji', kind: 'stooq' },
    { provider: 'gate', symbol: 'US30_USDT', kind: 'gate' },
  ],
};

const BARS = {
  M5: { binance: '5m', okx: '5m', stooq: 5, gate: '5m', coinbase: 300 },
  H1: { binance: '1h', okx: '1H', stooq: 60, gate: '1h', coinbase: 3600 },
};

function sourcesFor(market) {
  const chain = CHAINS[market];
  if (!chain) throw new Error(`mercado sin respaldo (${market})`);
  return chain.map((item) => ({ ...item }));
}

function parseBinance(rows) {
  if (!Array.isArray(rows)) throw new Error(rows?.msg || 'Binance sin velas');
  return rows.flatMap((r) => {
    if (!r || r.length < 6 || r[0] == null) return [];
    const [open, high, low, close] = [Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])];
    if (![open, high, low, close].every(Number.isFinite)) return [];
    return [{ time: Math.floor(Number(r[0]) / 1000), open, high, low, close, volume: Number(r[5]) || 0 }];
  });
}

function parseOkx(payload) {
  if (String(payload?.code) !== '0') throw new Error(payload?.msg || 'OKX sin velas');
  const rates = (payload.data || []).flatMap((r) => {
    if (!r || r.length < 6) return [];
    const [open, high, low, close] = [Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])];
    if (![open, high, low, close].every(Number.isFinite)) return [];
    return [{ time: Math.floor(Number(r[0]) / 1000), open, high, low, close, volume: Number(r[5]) || 0 }];
  });
  rates.sort((a, b) => a.time - b.time);
  return rates;
}

function parseStooq(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw || /^no data/i.test(raw)) throw new Error('Stooq sin datos');
  if (raw.startsWith('<') || /<html/i.test(raw.slice(0, 80)) || /verify your browser/i.test(raw)) {
    throw new Error('Stooq devolvió HTML (verificación del navegador), no CSV');
  }
  const lines = raw.split(/\r?\n/).filter((ln) => ln.trim());
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('open') || header.includes('date');
  const col = (name, fallback) => (hasHeader && header.includes(name) ? header.indexOf(name) : fallback);
  const idx = {
    date: col('date', 0),
    time: col('time', null),
    open: col('open', 1),
    high: col('high', 2),
    low: col('low', 3),
    close: col('close', 4),
    volume: col('volume', 5),
  };
  const start = hasHeader ? 1 : 0;
  const rates = [];
  for (const ln of lines.slice(start)) {
    const cells = ln.split(',').map((c) => c.trim());
    const date = cells[idx.date];
    const time = idx.time == null ? '' : cells[idx.time];
    const nums = [idx.open, idx.high, idx.low, idx.close].map((i) => Number(cells[i]));
    if (!date || nums.some((n) => !Number.isFinite(n))) continue;
    const stamp = Date.parse(time ? `${date}T${time}Z` : `${date}T00:00:00Z`);
    if (!Number.isFinite(stamp)) continue;
    rates.push({
      time: Math.floor(stamp / 1000), open: nums[0], high: nums[1], low: nums[2], close: nums[3],
      volume: Number(cells[idx.volume]) || 0,
    });
  }
  rates.sort((a, b) => a.time - b.time);
  return rates;
}

function urlFor(item, bar) {
  const sym = encodeURIComponent(item.symbol);
  if (item.kind === 'binance-spot') {
    return `https://api.binance.com/api/v3/klines?symbol=${item.symbol}&interval=${bar.binance}&limit=300`;
  }
  if (item.kind === 'binance-futures') {
    return `https://fapi.binance.com/fapi/v1/klines?symbol=${item.symbol}&interval=${bar.binance}&limit=300`;
  }
  if (item.kind === 'okx') {
    return `https://www.okx.com/api/v5/market/candles?instId=${sym}&bar=${bar.okx}&limit=300`;
  }
  if (item.kind === 'stooq') {
    return `https://stooq.com/q/d/l/?s=${sym}&i=${bar.stooq}`;
  }
  if (item.kind === 'gate') {
    return `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${sym}&interval=${bar.gate}&limit=300`;
  }
  if (item.kind === 'coinbase') {
    return `https://api.exchange.coinbase.com/products/${sym}/candles?granularity=${bar.coinbase}`;
  }
  throw new Error(`fuente desconocida: ${item.kind}`);
}

function parseBody(item, payload) {
  if (item.kind.startsWith('binance')) return parseBinance(payload);
  if (item.kind === 'okx') return parseOkx(payload);
  if (item.kind === 'stooq') return parseStooq(payload);
  if (item.kind === 'gate') {
    const rows = (Array.isArray(payload) ? payload : []).map((r) => (
      r && r.t != null ? { time: Number(r.t), open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v || 0 } : null
    )).filter(Boolean);
    rows.sort((a, b) => a.time - b.time);
    return rows;
  }
  if (item.kind === 'coinbase') {
    const rows = (Array.isArray(payload) ? payload : []).map((r) => (
      r && r.length >= 6 ? { time: Number(r[0]), open: +r[3], high: +r[2], low: +r[1], close: +r[4], volume: +r[5] || 0 } : null
    )).filter(Boolean);
    rows.sort((a, b) => a.time - b.time);
    return rows;
  }
  throw new Error(`fuente desconocida: ${item.kind}`);
}

function rejectWrong(market, symbol) {
  if (!symbol) return;
  const up = symbol.toUpperCase();
  if (market !== 'btc' && (up.startsWith('BTC') || up.includes('BTC'))) {
    throw new Error(`${market} no usa velas de BTC (${symbol})`);
  }
}

/**
 * @param {{ market: string, timeframe: string, count: number, failures: string[], fetchImpl: Function }} opts
 */
async function fallbackAfterYahoo({ market, timeframe, count, failures, fetchImpl }) {
  const chain = sourcesFor(market);
  const bar = BARS[timeframe];
  if (!bar) throw new Error(`marco no soportado (${timeframe})`);
  const tried = [...failures];
  for (const item of chain) {
    const pretty = PRETTY[item.provider];
    if (item.skip) {
      tried.push(`${pretty}: ${item.skip}`);
      continue;
    }
    const shown = `${pretty} ${item.symbol}`.trim();
    try {
      rejectWrong(market, item.symbol);
      const url = urlFor(item, bar);
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 FlashSignals/1.0', Accept: item.kind === 'stooq' ? 'text/csv,*/*' : 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = item.kind === 'stooq' ? await res.text() : await res.json();
      const rates = parseBody(item, payload);
      if (!rates.length) throw new Error('sin velas');
      const last = rates.at(-1);
      return {
        symbol: item.symbol,
        timeframe,
        bid: last.close,
        ask: last.close,
        tickTime: last.time,
        rates: rates.slice(-count),
        source: item.provider,
        sourceLabel: shown,
        failures: tried,
      };
    } catch (err) {
      tried.push(`${shown}: ${err?.message || err}`);
    }
  }
  const err = new Error(`No se pudieron obtener velas de ${market}. Fuentes probadas: ${tried.join('; ')}`);
  err.status = 502;
  throw err;
}

module.exports = {
  CHAINS, PRETTY, sourcesFor, parseBinance, parseOkx, parseStooq, fallbackAfterYahoo,
};
