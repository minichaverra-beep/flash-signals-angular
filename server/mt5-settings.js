/**
 * Configuración MT5 editable desde la UI (/configuracion), persistida en data/mt5-settings.json.
 * Las variables MT5_* del entorno solo son los valores por defecto.
 */
const fs = require('node:fs');
const path = require('node:path');

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
    symbols: {
      btc: process.env.MT5_SYMBOL_BTC || 'BTCUSD',
      us30: process.env.MT5_SYMBOL_US30 || 'US30',
      xauusd: process.env.MT5_SYMBOL_XAUUSD || 'XAUUSD',
    },
    riskPct: envNumber('MT5_RISK_PCT') ?? 0.5,
    volume: envNumber('MT5_VOLUME'),
    maxDeviationPct: envNumber('MT5_MAX_DEVIATION_PCT') ?? 1,
    expiryMinutes: envNumber('MT5_EXPIRY_MINUTES') ?? 30,
    deviationPoints: 20,
    allowMultiple: false,
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
function validatePatch(patch) {
  const errors = [];
  const value = {};
  if (!patch || typeof patch !== 'object') return { value, errors: ['Body inválido'] };

  if (patch.bridgeUrl !== undefined) {
    try {
      const url = new URL(String(patch.bridgeUrl));
      if (!/^https?:$/.test(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('host');
      value.bridgeUrl = url.origin;
    } catch {
      errors.push('bridgeUrl: debe ser http://127.0.0.1:<puerto> o http://localhost:<puerto>');
    }
  }
  if (patch.bridgeToken !== undefined) {
    const token = String(patch.bridgeToken ?? '');
    if (token.length > 200) errors.push('bridgeToken: máximo 200 caracteres');
    else value.bridgeToken = token;
  }
  if (patch.symbols !== undefined) {
    if (!patch.symbols || typeof patch.symbols !== 'object') {
      errors.push('symbols: objeto { btc, us30, xauusd }');
    } else {
      for (const market of SIGNAL_MARKETS) {
        if (patch.symbols[market] === undefined) continue;
        const sym = String(patch.symbols[market]).trim();
        if (!SYMBOL_RE.test(sym)) errors.push(`symbols.${market}: símbolo inválido`);
        else (value.symbols ??= {})[market] = sym;
      }
    }
  }
  if (patch.riskPct !== undefined) {
    value.riskPct = numberIn(errors, 'riskPct', patch.riskPct, { min: 0, max: 5, minExclusive: true });
  }
  if (patch.volume !== undefined) {
    value.volume =
      patch.volume === null || patch.volume === ''
        ? null
        : numberIn(errors, 'volume', patch.volume, { min: 0, max: 100, minExclusive: true });
  }
  if (patch.maxDeviationPct !== undefined) {
    value.maxDeviationPct = numberIn(errors, 'maxDeviationPct', patch.maxDeviationPct, {
      min: 0,
      max: 10,
      minExclusive: true,
    });
  }
  if (patch.expiryMinutes !== undefined) {
    value.expiryMinutes = numberIn(errors, 'expiryMinutes', patch.expiryMinutes, { min: 0, max: 1440, integer: true });
  }
  if (patch.deviationPoints !== undefined) {
    value.deviationPoints = numberIn(errors, 'deviationPoints', patch.deviationPoints, {
      min: 1,
      max: 1000,
      integer: true,
    });
  }
  if (patch.allowMultiple !== undefined) {
    if (typeof patch.allowMultiple !== 'boolean') errors.push('allowMultiple: true/false');
    else value.allowMultiple = patch.allowMultiple;
  }
  return { value, errors };
}

function merge(base, patch) {
  return { ...base, ...patch, symbols: { ...base.symbols, ...(patch.symbols || {}) } };
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
  for (const id of PROFILES) profiles[id] = merge(base, cleanPatch(rawProfiles[id]));
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
  const next = { ...s, profiles: { ...s.profiles, [profile]: merge(s.profiles[profile], value) } };
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
