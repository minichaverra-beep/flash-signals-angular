/**
 * Configuración MT5 editable desde la UI (/configuracion), persistida en data/mt5-settings.json.
 * Las variables MT5_* del entorno solo son los valores por defecto.
 */
const fs = require('node:fs');
const path = require('node:path');
const { VIX_DEFAULTS, thresholdsError } = require('./volatility');
const { MODES, normalizeMode } = require('./data-source');

const SIGNAL_MARKETS = ['btc', 'us30', 'xauusd'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SYMBOL_RE = /^[A-Za-z0-9._#+-]{1,32}$/;

function settingsPath() {
  if (process.env.MT5_SETTINGS_PATH) return process.env.MT5_SETTINGS_PATH;
  const dataDir = process.env.HISTORY_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'mt5-settings.json');
}

function envNumber(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function defaults() {
  return {
    bridgeUrl: process.env.MT5_BRIDGE_URL || 'http://127.0.0.1:8765',
    bridgeToken: process.env.MT5_BRIDGE_TOKEN || '',
    /** Fuente de velas para gráficos/análisis: 'auto' | 'yahoo' | 'mt5' (env FS_DATA_SOURCE manda). */
    dataSource: 'auto',
    symbols: {
      btc: process.env.MT5_SYMBOL_BTC || 'BTCUSD',
      us30: process.env.MT5_SYMBOL_US30 || 'US30',
      xauusd: process.env.MT5_SYMBOL_XAUUSD || 'XAUUSD',
    },
    riskPct: envNumber('MT5_RISK_PCT') ?? 0.5,
    volume: envNumber('MT5_VOLUME'),
    /** Balance (USD) introducido a mano para el lote recomendado en el móvil; null = sin configurar. */
    accountBalance: null,
    maxDeviationPct: envNumber('MT5_MAX_DEVIATION_PCT') ?? 1,
    /** 0 = la orden LIMIT no caduca (GTC). */
    expiryMinutes: envNumber('MT5_EXPIRY_MINUTES') ?? 0,
    deviationPoints: 20,
    allowMultiple: false,
    /** Señales con setup REVERSE: desactivadas salvo que se activen (~25 % de probabilidad). */
    reversalsEnabled: false,
    /** Límite de operaciones por día (día local, HISTORY_TZ); activo por defecto. */
    dailyTradeLimitEnabled: true,
    maxTradesPerDay: 6,
    /** Drawdown diario máx. (%); 0 = sin límite. */
    maxDailyDrawdownPct: 0,
    /** Margen extra sobre el SL/TP de la señal, en pips (0 = niveles exactos de la señal). */
    extraSlPips: 30,
    extraTpPips: 30,
    /** Valor en precio de 1 pip por mercado. */
    pipSize: { btc: 1, us30: 1, xauusd: 0.1 },
    /** Ajusta SL/TP de la señal según el nivel del VIX al enviar (desactivado por defecto). */
    volatilityAdjustEnabled: false,
    /** Símbolo del VIX en el broker; vacío = buscarlo en el puente (si no existe se usa Yahoo ^VIX). */
    vixSymbol: '',
    /** Umbrales (puntos VIX) y multiplicadores de SL/TP por nivel. */
    ...VIX_DEFAULTS,
  };
}

function numberIn(errors, key, raw, { min, max, integer = false, minExclusive = false }) {
  const n = Number(raw);
  const tooLow = minExclusive ? n <= min : n < min;
  if (raw === '' || raw == null || !Number.isFinite(n) || tooLow || n > max || (integer && !Number.isInteger(n))) {
    const range = `${minExclusive ? '>' : '≥'} ${min} y ≤ ${max}`;
    errors.push(`${key}: debe ser ${integer ? 'un entero ' : ''}${range}`);
    return undefined;
  }
  return n;
}

/**
 * Valida un patch parcial. Solo se aplican los campos presentes.
 * @returns {{ value: object, errors: string[] }}
 */
/** Campos numéricos del patch y su rango. */
const NUMBER_FIELDS = {
  riskPct: { min: 0, max: 5, minExclusive: true },
  maxDeviationPct: { min: 0, max: 10, minExclusive: true },
  expiryMinutes: { min: 0, max: 1440, integer: true },
  deviationPoints: { min: 1, max: 1000, integer: true },
  extraSlPips: { min: 0, max: 10000 },
  extraTpPips: { min: 0, max: 10000 },
  maxTradesPerDay: { min: 1, max: 100, integer: true },
  maxDailyDrawdownPct: { min: 0, max: 100 },
  vixLowMax: { min: 0, max: 200, minExclusive: true },
  vixNormalMax: { min: 0, max: 200, minExclusive: true },
  vixHighMax: { min: 0, max: 200, minExclusive: true },
  vixMultLow: { min: 0.2, max: 4 },
  vixMultNormal: { min: 0.2, max: 4 },
  vixMultHigh: { min: 0.2, max: 4 },
  vixMultExtreme: { min: 0.2, max: 4 },
};

function validateBridgeUrl(errors, raw) {
  try {
    const url = new URL(String(raw));
    if (!/^https?:$/.test(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('host');
    return url.origin;
  } catch {
    errors.push('bridgeUrl: debe ser http://127.0.0.1:<puerto> o http://localhost:<puerto>');
    return undefined;
  }
}

/** Objeto { btc, us30, xauusd } validado campo a campo; undefined si no queda ninguno válido. */
function validateMarketMap(errors, name, raw, parse) {
  if (!raw || typeof raw !== 'object') {
    errors.push(`${name}: objeto { btc, us30, xauusd }`);
    return undefined;
  }
  const out = {};
  for (const market of SIGNAL_MARKETS) {
    if (raw[market] === undefined) continue;
    const v = parse(raw[market], `${name}.${market}`);
    if (v !== undefined) out[market] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Validador por campo: (errors, raw) → valor válido o undefined (con el error añadido). */
const FIELD_VALIDATORS = {
  bridgeUrl: validateBridgeUrl,
  bridgeToken(errors, raw) {
    const token = String(raw ?? '');
    if (token.length <= 200) return token;
    errors.push('bridgeToken: máximo 200 caracteres');
    return undefined;
  },
  dataSource(errors, raw) {
    const mode = typeof raw === 'string' ? normalizeMode(raw) : null;
    if (mode) return mode;
    errors.push(`dataSource: debe ser ${MODES.join(' | ')}`);
    return undefined;
  },
  symbols(errors, raw) {
    return validateMarketMap(errors, 'symbols', raw, (v, label) => {
      const sym = String(v).trim();
      if (SYMBOL_RE.test(sym)) return sym;
      errors.push(`${label}: símbolo inválido`);
      return undefined;
    });
  },
  pipSize(errors, raw) {
    return validateMarketMap(errors, 'pipSize', raw, (v, label) =>
      numberIn(errors, label, v, { min: 0, max: 1000, minExclusive: true })
    );
  },
  volume(errors, raw) {
    if (raw === null || raw === '') return null;
    return numberIn(errors, 'volume', raw, { min: 0, max: 100, minExclusive: true });
  },
  accountBalance(errors, raw) {
    if (raw === null || raw === '') return null;
    return numberIn(errors, 'accountBalance', raw, { min: 0, max: 1e9, minExclusive: true });
  },
  allowMultiple(errors, raw) {
    if (typeof raw === 'boolean') return raw;
    errors.push('allowMultiple: true/false');
    return undefined;
  },
  reversalsEnabled(errors, raw) {
    if (typeof raw === 'boolean') return raw;
    errors.push('reversalsEnabled: true/false');
    return undefined;
  },
  dailyTradeLimitEnabled(errors, raw) {
    if (typeof raw === 'boolean') return raw;
    errors.push('dailyTradeLimitEnabled: true/false');
    return undefined;
  },
  volatilityAdjustEnabled(errors, raw) {
    if (typeof raw === 'boolean') return raw;
    errors.push('volatilityAdjustEnabled: true/false');
    return undefined;
  },
  vixSymbol(errors, raw) {
    const sym = String(raw ?? '').trim();
    if (sym === '' || SYMBOL_RE.test(sym)) return sym;
    errors.push('vixSymbol: símbolo inválido');
    return undefined;
  },
  ...Object.fromEntries(
    Object.entries(NUMBER_FIELDS).map(([key, range]) => [key, (errors, raw) => numberIn(errors, key, raw, range)])
  ),
};

function validatePatch(patch) {
  const errors = [];
  const value = {};
  if (!patch || typeof patch !== 'object') return { value, errors: ['Body inválido'] };
  for (const [key, validate] of Object.entries(FIELD_VALIDATORS)) {
    if (patch[key] === undefined) continue;
    const v = validate(errors, patch[key]);
    if (v !== undefined) value[key] = v;
  }
  return { value, errors };
}

function merge(base, patch) {
  return {
    ...base,
    ...patch,
    symbols: { ...base.symbols, ...patch.symbols },
    pipSize: { ...base.pipSize, ...patch.pipSize },
  };
}

/** Perfiles de configuración; el activo es el que se usa al enviar operaciones a MT5. */
const PROFILES = ['principal', 'secundaria'];
const PROFILE_LABELS = { principal: 'Conf principal', secundaria: 'Conf secundaria' };

/** @type {{ active: string, profiles: Record<string, object> } | null} */
let cache = null;

function cleanPatch(raw) {
  const { value } = validatePatch(raw || {});
  for (const k of Object.keys(value)) if (value[k] === undefined) delete value[k];
  return value;
}

function load() {
  const base = defaults();
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    saved = null;
  }
  // Formato antiguo (un solo perfil plano) → Conf principal.
  const rawProfiles = saved?.profiles ?? (saved ? { principal: saved } : {});
  const profiles = {};
  for (const id of PROFILES) {
    const profile = merge(base, cleanPatch(rawProfiles[id]));
    // Archivo editado a mano con umbrales desordenados: vuelven a los de fábrica.
    profiles[id] = thresholdsError(profile)
      ? { ...profile, vixLowMax: base.vixLowMax, vixNormalMax: base.vixNormalMax, vixHighMax: base.vixHighMax }
      : profile;
  }
  const active = PROFILES.includes(saved?.active) ? saved.active : 'principal';
  return { active, profiles };
}

function state() {
  if (!cache) cache = load();
  return cache;
}

function badRequest(errors) {
  const err = new Error(errors.join(' · '));
  err.status = 400;
  err.errors = errors;
  return err;
}

function assertProfile(profile) {
  if (!PROFILES.includes(profile)) throw badRequest([`profile: debe ser ${PROFILES.join(' | ')}`]);
}

function persist(next) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  cache = next;
}

/** Configuración de un perfil (por defecto el activo). */
function get(profile) {
  const s = state();
  return s.profiles[profile ?? s.active];
}

function getActive() {
  return state().active;
}

/** Vista para la UI: el token nunca sale del servidor. */
function toPublic(settings = get()) {
  const { bridgeToken, ...rest } = settings;
  return { ...rest, hasToken: !!bridgeToken };
}

function publicState() {
  const s = state();
  const profiles = {};
  for (const id of PROFILES) profiles[id] = toPublic(s.profiles[id]);
  return { active: s.active, profiles, labels: PROFILE_LABELS };
}

/**
 * Aplica un patch parcial a un perfil (por defecto el activo) y lo persiste.
 * @throws {Error & { status: number, errors: string[] }}
 */
function update(patch, profile = getActive()) {
  assertProfile(profile);
  const { value, errors } = validatePatch(patch);
  if (errors.length) throw badRequest(errors);
  const s = state();
  const merged = merge(s.profiles[profile], value);
  const orderError = thresholdsError(merged);
  if (orderError) throw badRequest([orderError]);
  const next = { ...s, profiles: { ...s.profiles, [profile]: merged } };
  persist(next);
  return next.profiles[profile];
}

function setActive(profile) {
  assertProfile(profile);
  persist({ ...state(), active: profile });
}

function reset() {
  cache = null;
}

module.exports = {
  SIGNAL_MARKETS,
  PROFILES,
  PROFILE_LABELS,
  defaults,
  get,
  getActive,
  publicState,
  setActive,
  toPublic,
  update,
  validatePatch,
  _resetForTests: reset,
};
