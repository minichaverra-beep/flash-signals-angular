/**
 * Valor actual del VIX (puntos). Prioridad: símbolo VIX del broker MT5 (puente, solo lectura)
 * y, si no existe o no responde, Yahoo Finance ^VIX. Caché de 60 s para no repetir peticiones.
 */
const tls = require('node:tls');
const mt5 = require('./mt5');

const CACHE_TTL_MS = 60_000;
const SYMBOL_TTL_MS = 10 * 60_000;
const BROKER_TIMEOUT_MS = 3000;
const YAHOO_TIMEOUT_MS = 4000;
/** Un tick más viejo que esto (mercado cerrado) no sirve como «VIX actual». */
const MAX_BROKER_TICK_AGE_SEC = 15 * 60;
/** Yahoo devuelve el último cierre con el mercado cerrado: se marca como dato no reciente. */
const STALE_AFTER_SEC = 30 * 60;
const VIX_RANGE = { min: 5, max: 150 };
const YAHOO_URLS = [
  'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1m&range=1d',
  'https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1m&range=1d',
];

let systemCaEnabled = false;

/** Windows con antivirus/proxy TLS: Node no confía en su CA; se añade el almacén del sistema (una vez). */
function enableSystemCa() {
  if (systemCaEnabled || typeof tls.setDefaultCACertificates !== 'function') return false;
  systemCaEnabled = true;
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  return true;
}

function isCertError(err) {
  const code = String(err?.cause?.code || err?.code || '');
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ISSUER/.test(code);
}

function reason(err) {
  const code = err?.cause?.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'tiempo de espera agotado';
  if (isCertError(err)) return 'certificado TLS no verificable (antivirus/proxy)';
  return code ? `${err.message} (${code})` : err?.message || 'error desconocido';
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: tiempo de espera agotado`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const plausible = (points) => Number.isFinite(points) && points >= VIX_RANGE.min && points <= VIX_RANGE.max;
const iso = (epochSec) => new Date(epochSec * 1000).toISOString();

/** Nombre del símbolo VIX en el broker: el indicado en el perfil o el más corto del puente que contenga «VIX». */
function pickVixSymbol(symbols = []) {
  const names = symbols.map((s) => String(s?.name || '')).filter((n) => /vix/i.test(n));
  return names.sort((a, b) => a.length - b.length)[0] || null;
}

function createVixSource({ bridge = mt5, fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
  /** @type {Map<string, { at: number, value: object }>} */
  const readings = new Map();
  /** @type {Map<string, { at: number, symbol: string|null }>} */
  const symbols = new Map();
  /** @type {Map<string, Promise<object>>} */
  const inFlight = new Map();

  async function brokerSymbol(settings) {
    if (settings.vixSymbol) return settings.vixSymbol;
    const key = settings.bridgeUrl;
    const known = symbols.get(key);
    if (known && now() - known.at < SYMBOL_TTL_MS) return known.symbol;
    const found = await withTimeout(bridge.searchSymbols('VIX', settings), BROKER_TIMEOUT_MS, 'puente MT5');
    const symbol = pickVixSymbol(found.symbols);
    symbols.set(key, { at: now(), symbol });
    return symbol;
  }

  async function fromBroker(settings, attempts) {
    let symbol;
    try {
      symbol = await brokerSymbol(settings);
      if (!symbol) {
        attempts.push('Broker: no hay símbolo VIX en tu cuenta MT5');
        return null;
      }
      const data = await withTimeout(
        bridge.marketRates({ symbol, timeframe: 'M1', count: 1 }, settings),
        BROKER_TIMEOUT_MS,
        'puente MT5'
      );
      const points = Number(data.bid) > 0 ? Number(data.bid) : Number(data.rates?.at(-1)?.close);
      const tickSec = Number(data.tickTime);
      if (!plausible(points)) {
        attempts.push(`Broker: ${symbol} devolvió ${points} (no parece un VIX)`);
        return null;
      }
      if (!(tickSec > 0) || now() / 1000 - tickSec > MAX_BROKER_TICK_AGE_SEC) {
        attempts.push(`Broker: ${symbol} sin cotización reciente (mercado cerrado)`);
        return null;
      }
      return { points, source: 'broker', sourceLabel: `Broker MT5 (${symbol})`, symbol, asOf: iso(tickSec), stale: false };
    } catch (err) {
      attempts.push(`Broker: ${reason(err)}`);
      return null;
    }
  }

  async function yahooRequest(url) {
    const request = () =>
      fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS) });
    let res;
    try {
      res = await request();
    } catch (err) {
      if (!isCertError(err) || !enableSystemCa()) throw err;
      res = await request();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = (await res.json())?.chart?.result?.[0]?.meta;
    const points = Number(meta?.regularMarketPrice);
    const timeSec = Number(meta?.regularMarketTime);
    if (!plausible(points)) throw new Error('respuesta sin precio del VIX');
    return { points, timeSec };
  }

  async function fromYahoo(attempts) {
    for (const url of YAHOO_URLS) {
      try {
        const { points, timeSec } = await yahooRequest(url);
        const asOfSec = timeSec > 0 ? timeSec : now() / 1000;
        return {
          points,
          source: 'yahoo',
          sourceLabel: 'Yahoo Finance (^VIX)',
          symbol: '^VIX',
          asOf: iso(asOfSec),
          stale: now() / 1000 - asOfSec > STALE_AFTER_SEC,
        };
      } catch (err) {
        attempts.push(`Yahoo Finance: ${reason(err)}`);
      }
    }
    return null;
  }

  async function read(settings) {
    const attempts = [];
    const value = (await fromBroker(settings, attempts)) || (await fromYahoo(attempts));
    if (!value) {
      const err = new Error(`No se pudo obtener el VIX · ${attempts.join(' · ')}`);
      err.status = 502;
      err.attempts = attempts;
      throw err;
    }
    return { ...value, attempts };
  }

  /**
   * VIX actual { points, source, sourceLabel, symbol, asOf, stale, attempts, cached }.
   * @throws {Error & { status: number, attempts: string[] }} si el broker y Yahoo fallan
   */
  async function getVix(settings) {
    const key = `${settings.bridgeUrl}|${settings.vixSymbol || ''}`;
    const hit = readings.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true, cachedAt: new Date(hit.at).toISOString() };
    if (!inFlight.has(key)) {
      const job = read(settings)
        .then((value) => {
          readings.set(key, { at: now(), value });
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    return { ...(await inFlight.get(key)), cached: false };
  }

  return { getVix, clear: () => (readings.clear(), symbols.clear()) };
}

const defaultSource = createVixSource();

module.exports = { createVixSource, pickVixSymbol, getVix: defaultSource.getVix, clearVixCache: defaultSource.clear };
