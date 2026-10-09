/**
 * Ajustes de la cuenta (balance y % de riesgo) para el lote recomendado de Señales.
 * Mismo estilo que history-store / macd-quant-store: better-sqlite3 + fallback sql.js.
 * Archivo: data/account-settings.sqlite (una sola fila, id = 1).
 */
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, 'account-settings-schema.sql');

const BALANCE_MAX = 1e9;
const RISK_MIN = 0.01;
const RISK_MAX = 100;
const CURRENCY_RE = /^[A-Z]{3}$/;

function getDataDir() {
  return (
    process.env.ACCOUNT_SETTINGS_DATA_DIR ||
    process.env.HISTORY_DATA_DIR ||
    path.join(__dirname, '..', '..', 'data')
  );
}

function getDbPath() {
  return path.join(getDataDir(), 'account-settings.sqlite');
}

/** @type {{ kind: 'better-sqlite3'|'sql.js', db: any, run: Function, get: Function } | null} */
let engine = null;

function readSchemaSql() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function openBetterSqlite3() {
  const Database = require('better-sqlite3');
  const db = new Database(getDbPath());
  db.pragma('journal_mode = WAL');
  db.exec(readSchemaSql());
  return {
    kind: 'better-sqlite3',
    db,
    run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
  };
}

async function openSqlJs() {
  const initSqlJs = require('sql.js');
  const sqlJsDist = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (file) => path.join(sqlJsDist, file) });
  const dbPath = getDbPath();
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  db.exec(readSchemaSql());
  const persist = () => fs.writeFileSync(dbPath, Buffer.from(db.export()));
  persist();
  return {
    kind: 'sql.js',
    db,
    run(sql, params = []) {
      db.run(sql, params);
      const changes = db.getRowsModified();
      persist();
      return { changes };
    },
    get(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        if (params.length) stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : undefined;
      } finally {
        stmt.free();
      }
    },
  };
}

async function getEngine() {
  if (engine) return engine;
  fs.mkdirSync(getDataDir(), { recursive: true });
  try {
    engine = openBetterSqlite3();
  } catch (err) {
    console.warn(`[account-settings] better-sqlite3 no disponible (${err.message}); usando sql.js`);
    engine = await openSqlJs();
  }
  engine.run(`INSERT OR IGNORE INTO account_settings_schema_migrations (id, applied_at) VALUES (?, ?)`, [
    '001_account_settings_init',
    new Date().toISOString(),
  ]);
  return engine;
}

function badRequest(errors) {
  const err = new Error(errors.join(' · '));
  err.status = 400;
  err.errors = errors;
  return err;
}

/** Campos numéricos: null (o '') borra el valor; si no, número dentro del rango. */
const NUMBER_FIELDS = {
  balance: {
    valid: (n) => n > 0 && n <= BALANCE_MAX,
    normalize: (n) => Math.round(n * 100) / 100,
    error: 'El balance debe ser un número mayor que 0',
  },
  riskPct: {
    valid: (n) => n >= RISK_MIN && n <= RISK_MAX,
    normalize: (n) => n,
    error: `El % de riesgo debe estar entre ${RISK_MIN} y ${RISK_MAX}`,
  },
};

function parseNumberField(raw, { valid, normalize, error }, errors) {
  if (raw === null || raw === '') return null;
  const n = typeof raw === 'boolean' ? Number.NaN : Number(raw);
  if (Number.isFinite(n) && valid(n)) return normalize(n);
  errors.push(error);
  return undefined;
}

/**
 * Valida un patch parcial { balance?, riskPct?, currency? }.
 * @returns {{ value: object, errors: string[] }}
 */
function validatePatch(patch) {
  const errors = [];
  const value = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { value, errors: ['Cuerpo de la petición inválido'] };
  }
  for (const [key, rule] of Object.entries(NUMBER_FIELDS)) {
    if (patch[key] === undefined) continue;
    const v = parseNumberField(patch[key], rule, errors);
    if (v !== undefined) value[key] = v;
  }
  if (patch.currency !== undefined) {
    const c = String(patch.currency ?? '').trim().toUpperCase();
    if (!CURRENCY_RE.test(c)) errors.push('La moneda debe ser un código de 3 letras (ej. USD)');
    else value.currency = c;
  }
  if (!errors.length && !Object.keys(value).length) {
    errors.push('Nada que guardar: envía balance, riskPct o currency');
  }
  return { value, errors };
}

function rowToSettings(row) {
  return {
    balance: row?.balance != null ? Number(row.balance) : null,
    currency: row?.currency || 'USD',
    riskPct: row?.risk_pct != null ? Number(row.risk_pct) : null,
    updatedAt: row?.updated_at || null,
  };
}

async function readRow() {
  const e = await getEngine();
  return e.get(`SELECT balance, currency, risk_pct, updated_at FROM account_settings WHERE id = 1`);
}

/** @returns {Promise<{ balance: number|null, currency: string, riskPct: number|null, updatedAt: string|null }>} */
async function get() {
  return rowToSettings(await readRow());
}

async function write(next) {
  const e = await getEngine();
  e.run(
    `INSERT INTO account_settings (id, balance, currency, risk_pct, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       balance = excluded.balance,
       currency = excluded.currency,
       risk_pct = excluded.risk_pct,
       updated_at = excluded.updated_at`,
    [next.balance, next.currency, next.riskPct, new Date().toISOString()]
  );
  return get();
}

/**
 * Aplica un patch parcial y lo persiste.
 * @throws {Error & { status: 400, errors: string[] }}
 */
async function update(patch) {
  const { value, errors } = validatePatch(patch);
  if (errors.length) throw badRequest(errors);
  const current = await get();
  return write({ ...current, ...value });
}

/**
 * Migración única: si la tabla está vacía, importa accountBalance / riskPct de mt5-settings.json.
 * Valores inválidos del JSON se ignoran.
 * @returns {Promise<boolean>} true si importó algo
 */
async function importLegacy(legacy) {
  if (!legacy || (await readRow())) return false;
  const { value } = validatePatch({
    ...(legacy.accountBalance != null ? { balance: legacy.accountBalance } : {}),
    ...(legacy.riskPct != null ? { riskPct: legacy.riskPct } : {}),
  });
  if (value.balance == null && value.riskPct == null) return false;
  await write({ balance: value.balance ?? null, currency: 'USD', riskPct: value.riskPct ?? null });
  return true;
}

/** @param {{ legacy?: { accountBalance?: number|null, riskPct?: number|null } }} [opts] */
async function init(opts = {}) {
  const e = await getEngine();
  console.log(`[account-settings] → ${e.kind} (${getDbPath()})`);
  if (await importLegacy(opts.legacy)) {
    console.log('[account-settings] balance / riesgo importados de mt5-settings.json');
  }
}

function _resetForTests() {
  try {
    engine?.db?.close?.();
  } catch {
    /* ignore */
  }
  engine = null;
}

module.exports = {
  init,
  get,
  update,
  importLegacy,
  validatePatch,
  _resetForTests,
  get DB_PATH() {
    return getDbPath();
  },
};
