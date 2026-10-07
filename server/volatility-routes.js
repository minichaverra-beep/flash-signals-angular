/**
 * Rutas de volatilidad (solo lectura): VIX actual, ATR del mercado y calculadora de volatilidad.
 * El puente MT5 solo se usa para leer velas, fichas de símbolo y saldo; nunca envía órdenes.
 */
const mt5 = require('./mt5');
const mt5Settings = require('./mt5-settings');
const vixSource = require('./vix-source');
const {
  ATR_PERIOD,
  LEVEL_LABELS,
  MOODS,
  MOOD_LEVEL,
  atrFromCandles,
  calculatePlan,
  classifyVix,
  levelMultiplier,
} = require('./volatility');

const SNAPSHOT_TTL_MS = 60_000;
const TIMEFRAMES = ['M5', 'H1'];
const CANDLES = 120;

/** @type {Map<string, { at: number, value: object }>} */
const snapshots = new Map();

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function profileOf(raw) {
  const id = typeof raw === 'string' && raw ? raw : mt5Settings.getActive();
  if (!mt5Settings.PROFILES.includes(id)) throw httpError(400, `profile debe ser ${mt5Settings.PROFILES.join(' | ')}`);
  return { id, settings: mt5Settings.get(id) };
}

function marketOf(raw) {
  const market = String(raw || '').toLowerCase();
  if (!mt5Settings.SIGNAL_MARKETS.includes(market)) {
    throw httpError(400, `market debe ser ${mt5Settings.SIGNAL_MARKETS.join(' | ')}`);
  }
  return market;
}

/** Lee del puente: velas → ATR, ficha del símbolo y equity. Caché de 60 s por perfil/mercado/marco. */
async function marketSnapshot(settings, market, timeframe) {
  const symbol = mt5.symbolFor(market, settings);
  if (!symbol) throw httpError(400, `Mercado ${market} sin símbolo MT5`);
  const key = `${settings.bridgeUrl}|${symbol}|${timeframe}`;
  const hit = snapshots.get(key);
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.value;

  const [rates, details, health] = await Promise.all([
    mt5.marketRates({ symbol, timeframe, count: CANDLES }, settings),
    mt5.symbolDetails(symbol, settings),
    mt5.bridgeHealth(settings).catch(() => null),
  ]);
  const atr = atrFromCandles(rates.rates, ATR_PERIOD);
  if (!atr) throw httpError(422, `${symbol}: el broker no devolvió velas suficientes para medir el movimiento`);
  const last = rates.rates.at(-1);
  const value = {
    symbol,
    timeframe,
    atr,
    price: Number(rates.bid) || last?.close || null,
    asOf: rates.tickTime ? new Date(rates.tickTime * 1000).toISOString() : null,
    candles: rates.rates.length,
    details,
    equity: Number(health?.account?.equity) || null,
    currency: details.currency || health?.account?.currency || 'USD',
  };
  snapshots.set(key, { at: Date.now(), value });
  return value;
}

function positive(raw, label, { max = Infinity } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw httpError(400, `${label} inválido`);
  return n;
}

async function vixResponse(settings) {
  const reading = await vixSource.getVix(settings);
  const level = classifyVix(reading.points, settings);
  return {
    points: reading.points,
    source: reading.source,
    sourceLabel: reading.sourceLabel,
    symbol: reading.symbol,
    asOf: reading.asOf,
    stale: reading.stale,
    cached: reading.cached,
    attempts: reading.attempts,
    level,
    levelLabel: level ? LEVEL_LABELS[level] : null,
    multiplier: levelMultiplier(level, settings),
    enabled: !!settings.volatilityAdjustEnabled,
  };
}

function fail(res, err, fallback) {
  const status = err.status >= 400 ? err.status : 500;
  if (status >= 500 && status !== 502 && status !== 503) console.error('[volatility]', err.message);
  res.status(status).json({ error: err.message || fallback, attempts: err.attempts });
}

function registerVolatilityRoutes(app) {
  /** GET /api/volatility/vix?profile= → { points, source, asOf, level, ... } | 502 { error } */
  app.get('/api/volatility/vix', async (req, res) => {
    try {
      const { settings } = profileOf(req.query.profile);
      res.json(await vixResponse(settings));
    } catch (err) {
      if (err.status === 502) {
        return res.status(502).json({ points: null, source: null, asOf: null, level: null, error: err.message, attempts: err.attempts });
      }
      fail(res, err, 'No se pudo obtener el VIX');
    }
  });

  /** GET /api/volatility/atr?market=btc&timeframe=M5&profile= */
  app.get('/api/volatility/atr', async (req, res) => {
    try {
      const { settings } = profileOf(req.query.profile);
      const market = marketOf(req.query.market);
      const timeframe = String(req.query.timeframe || 'M5').toUpperCase();
      if (!TIMEFRAMES.includes(timeframe)) throw httpError(400, `timeframe debe ser ${TIMEFRAMES.join(' | ')}`);
      const snap = await marketSnapshot(settings, market, timeframe);
      const pipSize = settings.pipSize[market];
      res.json({
        market,
        symbol: snap.symbol,
        timeframe,
        period: ATR_PERIOD,
        atr: snap.atr,
        atrPips: Math.round((snap.atr / pipSize) * 10) / 10,
        pipSize,
        price: snap.price,
        asOf: snap.asOf,
        candles: snap.candles,
      });
    } catch (err) {
      fail(res, err, 'No se pudo leer la volatilidad del mercado');
    }
  });

  /**
   * POST /api/volatility/calc { market, mood, riskPct, balance?, multiplier?, pipSize?, profile? }
   * multiplier / pipSize opcionales: la UI envía los valores del borrador sin guardar.
   */
  app.post('/api/volatility/calc', async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { settings } = profileOf(body.profile);
      const market = marketOf(body.market);
      const mood = String(body.mood || 'normal');
      if (!MOODS.includes(mood)) throw httpError(400, `mood debe ser ${MOODS.join(' | ')}`);
      const riskPct = positive(body.riskPct, 'riskPct', { max: 100 });
      const level = MOOD_LEVEL[mood];
      const multiplier =
        body.multiplier == null ? levelMultiplier(level, settings) : positive(body.multiplier, 'multiplier', { max: 4 });
      const pipSize = body.pipSize == null ? settings.pipSize[market] : positive(body.pipSize, 'pipSize', { max: 1000 });

      const snap = await marketSnapshot(settings, market, 'M5');
      const typed = body.balance == null || body.balance === '' ? null : positive(body.balance, 'balance');
      const balance = typed ?? snap.equity;
      if (!balance) throw httpError(400, 'Indica el saldo de la cuenta (no se pudo leer el de MT5)');

      const plan = calculatePlan({ atr: snap.atr, multiplier, riskPct, balance, pipSize, symbol: snap.details });
      res.json({
        market,
        symbol: snap.symbol,
        mood,
        level,
        levelLabel: LEVEL_LABELS[level],
        multiplier,
        riskPct,
        balance,
        balanceSource: typed ? 'usuario' : 'mt5',
        currency: snap.currency,
        atr: snap.atr,
        atrPips: Math.round((snap.atr / pipSize) * 10) / 10,
        pipSize,
        price: snap.price,
        asOf: snap.asOf,
        plan,
      });
    } catch (err) {
      fail(res, err, 'No se pudo calcular');
    }
  });
}

module.exports = { registerVolatilityRoutes, marketSnapshot, _clearSnapshots: () => snapshots.clear() };
