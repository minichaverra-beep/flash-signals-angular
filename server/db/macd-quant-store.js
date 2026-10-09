/**
 * Historial local de análisis MACD-quant H4.
 * Mismo estilo que history-store / wiki-store: better-sqlite3 + fallback sql.js.
 * Archivo: data/macd-quant-history.sqlite
 * PNG: data/macd-quant-charts/
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'macd-quant-schema.sql');

const MARKETS = new Set(['btc', 'us30', 'xauusd', 'ukoil']);

/** Baseline documentado (soft-filter); no se inventan métricas WR/PF. */
const DEFAULT_PARAMS = { fast: 12, slow: 26, signal: 9 };

/** Análisis más recientes que se conservan por mercado; el resto se borra (fila + PNG). */
const KEEP_PER_MARKET = 4;

function getDataDir() {
  return (
    process.env.MACD_QUANT_DATA_DIR ||
    process.env.HISTORY_DATA_DIR ||
    path.join(__dirname, '..', '..', 'data')
  );
}

function getDbPath() {
  return path.join(getDataDir(), 'macd-quant-history.sqlite');
}

function getChartsDir() {
  return path.join(getDataDir(), 'macd-quant-charts');
}

/** @type {{ kind: 'better-sqlite3'|'sql.js', db: any, save?: () => void } | null} */
let engine = null;

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function ensureChartsDir() {
  const dir = getChartsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function readSchemaSql() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function openBetterSqlite3() {
  const Database = require('better-sqlite3');
  const dbPath = getDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(readSchemaSql());
  const eng = {
    kind: 'better-sqlite3',
    db,
    run(sql, params = []) {
      return db.prepare(sql).run(...params);
    },
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
  };
  applyMigrations(eng);
  return eng;
}

async function openSqlJs() {
  const initSqlJs = require('sql.js');
  const sqlJsDist = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(sqlJsDist, file),
  });
  const dbPath = getDbPath();
  let db;
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  db.exec(readSchemaSql());

  const persist = () => {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  };
  persist();

  const readLastInsertRowid = () => {
    const stmt = db.prepare('SELECT last_insert_rowid() AS id');
    try {
      if (stmt.step()) {
        return Number(stmt.getAsObject().id) || 0;
      }
      return 0;
    } finally {
      stmt.free();
    }
  };

  const eng = {
    kind: 'sql.js',
    db,
    save: persist,
    run(sql, params = []) {
      db.run(sql, params);
      const changes = db.getRowsModified();
      const lastInsertRowid = readLastInsertRowid();
      persist();
      return { changes, lastInsertRowid };
    },
    get(sql, params = []) {
      const stmt = db.prepare(sql);
      if (params && params.length) stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    },
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      if (params && params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    },
  };
  applyMigrations(eng);
  return eng;
}

function applyMigrations(e) {
  const now = new Date().toISOString();
  e.run(
    `INSERT OR IGNORE INTO macd_quant_schema_migrations (id, applied_at) VALUES (?, ?)`,
    ['001_macd_quant_init', now]
  );
}

async function getEngine() {
  if (engine) return engine;
  ensureDataDir();
  try {
    engine = openBetterSqlite3();
    console.log(`[macd-quant] hive box → better-sqlite3 (${getDbPath()})`);
    return engine;
  } catch (err) {
    console.warn(
      `[macd-quant] better-sqlite3 no disponible (${err.message}); usando sql.js`
    );
    engine = await openSqlJs();
    console.log(`[macd-quant] hive box → sql.js (${getDbPath()})`);
    return engine;
  }
}

function _resetForTests() {
  if (engine?.db) {
    try {
      if (typeof engine.db.close === 'function') engine.db.close();
    } catch {
      /* ignore */
    }
  }
  engine = null;
}

async function getBackendKind() {
  const e = await getEngine();
  return e.kind;
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeMarket(raw) {
  const m = String(raw || '').toLowerCase();
  return MARKETS.has(m) ? m : null;
}

function rowToListItem(row) {
  if (!row) return null;
  const softFilter = parseJson(row.soft_filter_json, {});
  const params = parseJson(row.params_json, null) || { ...DEFAULT_PARAMS };
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    market: row.market,
    timeframe: row.timeframe || 'H4',
    days:
      row.days != null && row.days !== '' ? Number(row.days) : null,
    status: row.status,
    softFilter,
    params,
    hasPng: Boolean(row.png_name != null && String(row.png_name).trim()),
    error: row.error || null,
  };
}

function rowToDetail(row) {
  if (!row) return null;
  const base = rowToListItem(row);
  return {
    ...base,
    sourcePngPath: row.source_png_path || null,
    pngName: row.png_name || null,
    command: row.command || null,
    exitCode: row.exit_code != null ? Number(row.exit_code) : null,
    logsTail: row.logs_tail || null,
  };
}

/**
 * Copia PNG a data/macd-quant-charts/ y persiste fila.
 * @param {object} snap
 * @param {string} [snap.sourcePngPath] ruta absoluta del PNG en live/
 */
async function insertAnalysis(snap) {
  const e = await getEngine();
  const now = new Date().toISOString();
  const market = normalizeMarket(snap.market);
  if (!market) {
    throw new Error('market inválido (btc|us30|xauusd|ukoil)');
  }

  const softFilter = {
    role: 'soft-filter',
    neverTriggerAlone: true,
    disclaimer:
      'MACD-quant H4 = soft-filter E1; nunca trigger solo. WR/PF PENDING.',
    ...(snap.softFilter && typeof snap.softFilter === 'object'
      ? snap.softFilter
      : {}),
  };
  const params = {
    ...DEFAULT_PARAMS,
    ...(snap.params && typeof snap.params === 'object' ? snap.params : {}),
  };

  const days =
    snap.days != null && Number.isFinite(Number(snap.days))
      ? Number(snap.days)
      : 7;

  const sql = `
    INSERT INTO macd_quant_history (
      created_at, started_at, finished_at, market, timeframe, days, status,
      soft_filter_json, params_json, png_name, source_png_path,
      command, exit_code, error, logs_tail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const paramsRow = [
    now,
    snap.startedAt || null,
    snap.finishedAt || now,
    market,
    String(snap.timeframe || 'H4'),
    days,
    String(snap.status || 'done'),
    JSON.stringify(softFilter),
    JSON.stringify(params),
    null, // png_name se actualiza tras copiar
    snap.sourcePngPath || null,
    snap.command || null,
    snap.exitCode != null ? Number(snap.exitCode) : null,
    snap.error || null,
    snap.logsTail != null ? String(snap.logsTail).slice(0, 20000) : null,
  ];

  const info = e.run(sql, paramsRow);
  const id = Number(info.lastInsertRowid);

  let pngName = null;
  const src = snap.sourcePngPath ? String(snap.sourcePngPath) : null;
  if (src && fs.existsSync(src)) {
    const dir = ensureChartsDir();
    const stamp = now.replace(/[:.]/g, '-');
    pngName = `${id}-${stamp}-${market}_h4_macd_quant.png`;
    const dest = path.join(dir, pngName);
    fs.copyFileSync(src, dest);
    e.run(`UPDATE macd_quant_history SET png_name = ? WHERE id = ?`, [
      pngName,
      id,
    ]);
  }

  await pruneOld(market);

  return { id, pngName };
}

/**
 * Borra análisis antiguos dejando los KEEP_PER_MARKET más recientes por mercado.
 * @param {string|null} [onlyMarket] si se indica, poda solo ese mercado
 */
async function pruneOld(onlyMarket = null, keep = KEEP_PER_MARKET) {
  const e = await getEngine();
  const markets = onlyMarket ? [onlyMarket] : [...MARKETS];
  let deleted = 0;
  for (const market of markets) {
    const stale = e.all(
      `SELECT id FROM macd_quant_history
       WHERE market = ?
       ORDER BY created_at DESC, id DESC
       LIMIT -1 OFFSET ?`,
      [market, keep]
    );
    for (const row of stale || []) {
      const r = await deleteById(row.id);
      deleted += r.deleted;
    }
  }
  return { deleted };
}

/**
 * @param {{ page?: number, pageSize?: number, market?: string|null }} opts
 */
async function listAnalyses(opts = {}) {
  const e = await getEngine();
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const market = normalizeMarket(opts.market);

  let total;
  let rows;
  if (market) {
    total = e.get(
      `SELECT COUNT(*) AS c FROM macd_quant_history WHERE market = ?`,
      [market]
    );
    rows = e.all(
      `SELECT id, created_at, started_at, finished_at, market, timeframe, days,
              status, soft_filter_json, params_json, png_name, error
       FROM macd_quant_history
       WHERE market = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [market, pageSize, offset]
    );
  } else {
    total = e.get(`SELECT COUNT(*) AS c FROM macd_quant_history`);
    rows = e.all(
      `SELECT id, created_at, started_at, finished_at, market, timeframe, days,
              status, soft_filter_json, params_json, png_name, error
       FROM macd_quant_history
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
  }

  const count = Number(total?.c ?? 0);
  return {
    items: (rows || []).map(rowToListItem),
    page,
    pageSize,
    total: count,
    totalPages: Math.max(1, Math.ceil(count / pageSize)),
  };
}

async function getById(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const row = e.get(`SELECT * FROM macd_quant_history WHERE id = ?`, [n]);
  return rowToDetail(row);
}

/**
 * @param {number} id
 * @returns {Promise<{ absPath: string, mime: string } | null>}
 */
async function getChartFile(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const row = e.get(
    `SELECT png_name FROM macd_quant_history WHERE id = ?`,
    [n]
  );
  if (!row?.png_name) return null;
  const name = String(row.png_name);
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return null;
  }
  const absPath = path.join(getChartsDir(), name);
  if (!fs.existsSync(absPath)) return null;
  return { absPath, mime: 'image/png' };
}

async function deleteById(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { deleted: 0 };
  const existing = e.get(
    `SELECT png_name FROM macd_quant_history WHERE id = ?`,
    [n]
  );
  if (existing?.png_name) {
    const abs = path.join(getChartsDir(), String(existing.png_name));
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
  const info = e.run(`DELETE FROM macd_quant_history WHERE id = ?`, [n]);
  return { deleted: Number(info.changes || 0) };
}

async function clearAll() {
  const e = await getEngine();
  const dir = getChartsDir();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  }
  const info = e.run(`DELETE FROM macd_quant_history`);
  return { deleted: Number(info.changes || 0) };
}

async function init() {
  await getEngine();
  ensureChartsDir();
  const { deleted } = await pruneOld();
  if (deleted) {
    console.log(`[macd-quant] historial podado: ${deleted} análisis antiguos borrados`);
  }
}

module.exports = {
  init,
  insertAnalysis,
  pruneOld,
  KEEP_PER_MARKET,
  listAnalyses,
  getById,
  getChartFile,
  deleteById,
  clearAll,
  getBackendKind,
  _resetForTests,
  DEFAULT_PARAMS,
  get DATA_DIR() {
    return getDataDir();
  },
  get DB_PATH() {
    return getDbPath();
  },
  get CHARTS_DIR() {
    return getChartsDir();
  },
};
