/**
 * Registro persistente de señales ya enviadas a MT5 (por perfil), para no ejecutar dos veces
 * la misma señal aunque se reinicie la API. Archivo JSON junto a mt5-settings.json.
 */
const fs = require('node:fs');
const path = require('node:path');

let cache = null;

function sentPath() {
  if (process.env.MT5_SENT_PATH) return process.env.MT5_SENT_PATH;
  const dataDir = process.env.HISTORY_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(dataDir, 'mt5-sent.json');
}

function state() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(sentPath(), 'utf8'));
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(next) {
  const file = sentPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  cache = next;
}

const keyOf = (profile, key) => `${profile}:${key}`;

function has(profile, key) {
  return Object.hasOwn(state(), keyOf(profile, key));
}

/** @param {object} result respuesta del puente (orden enviada) → entrada registrada. */
function entryOf(result = {}) {
  return {
    at: new Date().toISOString(),
    symbol: result.symbol ?? null,
    side: result.side ?? null,
    mode: result.mode ?? null,
    volume: result.volume ?? null,
    price: result.price ?? null,
    sl: result.sl ?? null,
    tp: result.tp ?? null,
    order: result.order ?? null,
    deal: result.deal ?? null,
    login: result.account?.login ?? null,
  };
}

/** @param {object} result respuesta del puente (orden enviada). */
function record(profile, key, result = {}) {
  const entry = entryOf(result);
  persist({ ...state(), [keyOf(profile, key)]: entry });
  return entry;
}

function get(profile, key) {
  return state()[keyOf(profile, key)] ?? null;
}

/** Fusiona el estado real de MT5 (Recalcular) en un envío ya registrado. */
function update(profile, key, patch = {}) {
  const k = keyOf(profile, key);
  const current = state()[k];
  if (!current) return null;
  const next = { ...current, ...patch };
  persist({ ...state(), [k]: next });
  return next;
}

/** Envíos de historial (claves h<id>) de un perfil → { [historyId]: entry }. */
function historyMap(profile) {
  const prefix = keyOf(profile, 'h');
  const out = {};
  for (const [k, v] of Object.entries(state())) {
    if (!k.startsWith(prefix)) continue;
    const id = Number(k.slice(prefix.length));
    if (Number.isInteger(id) && id > 0) out[id] = v;
  }
  return out;
}

function _resetForTests() {
  cache = null;
}

module.exports = { has, get, entryOf, record, update, historyMap, _resetForTests };
