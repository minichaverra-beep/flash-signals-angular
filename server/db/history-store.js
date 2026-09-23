/**
 * Hive box / caja local — almacén embebido SQLite para historial de señales.
 * Preferencia: better-sqlite3. Fallback: sql.js (WASM, sin nativos) si falla en Windows.
 * Archivo: data/signals-history.sqlite (gitignored).
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function getDataDir() {
  return (
    process.env.HISTORY_DATA_DIR ||
    path.join(__dirname, '..', '..', 'data')
  );
}

function getDbPath() {
  return path.join(getDataDir(), 'signals-history.sqlite');
}

/** @type {{ kind: 'better-sqlite3'|'sql.js', db: any, save?: () => void } | null} */
let engine = null;

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readSchemaSql() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

function openBetterSqlite3() {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const Database = require('better-sqlite3');
  const dbPath = getDbPath();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(readSchemaSql());
  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`
  ).run('001_init', new Date().toISOString());
  return {
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
}

async function openSqlJs() {
  const initSqlJs = require('sql.js');
  // Ruta explícita al WASM: evita fallos de resolve en Windows / cwd distintos.
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
  // exec: multi-statement (run solo garantiza el primero en algunas builds).
  db.exec(readSchemaSql());
  try {
    db.run(
      `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['001_init', new Date().toISOString()]
    );
  } catch {
    /* ignore */
  }

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

  return {
    kind: 'sql.js',
    db,
    save: persist,
    run(sql, params = []) {
      db.run(sql, params);
      // db.export() resetea getRowsModified() y last_insert_rowid() a 0.
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
}

async function getEngine() {
  if (engine) return engine;
  ensureDataDir();
  try {
    engine = openBetterSqlite3();
    console.log(`[history] hive box → better-sqlite3 (${getDbPath()})`);
    return engine;
  } catch (err) {
    console.warn(
      `[history] better-sqlite3 no disponible (${err.message}); usando sql.js`
    );
    engine = await openSqlJs();
    console.log(`[history] hive box → sql.js (${getDbPath()})`);
    return engine;
  }
}

/** Cierra el motor y limpia el singleton (solo tests). */
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

function rowToListItem(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    market: row.market,
    tier: row.tier,
    status: row.status,
    verdict: row.verdict || null,
    scoreCombined:
      row.score_combined != null && row.score_combined !== ''
        ? Number(row.score_combined)
        : null,
    entry: row.entry || null,
    error: row.error || null,
    flags: parseJson(row.flags_json, {}),
  };
}

function rowToDetail(row) {
  if (!row) return null;
  const base = rowToListItem(row);
  return {
    ...base,
    summary: parseJson(row.summary_json, null),
    reportPath: row.report_path || null,
    chartPath: row.chart_path || null,
    preview: row.preview || null,
    command: row.command || null,
    exitCode: row.exit_code != null ? Number(row.exit_code) : null,
  };
}

/**
 * Persiste un snapshot real del job (solo lo que produjo el pipeline).
 * @param {object} snap
 */
async function insertSnapshot(snap) {
  const e = await getEngine();
  const now = new Date().toISOString();
  const summary = snap.summary || null;
  const verdict = summary?.verdict || snap.verdict || null;
  const scoreCombined =
    summary?.scoreCombined != null ? Number(summary.scoreCombined) : null;

  const sql = `
    INSERT INTO signal_history (
      created_at, started_at, finished_at, market, tier, status,
      flags_json, entry, verdict, score_combined, summary_json,
      report_path, chart_path, preview, command, exit_code, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    now,
    snap.startedAt || null,
    snap.finishedAt || now,
    String(snap.market || ''),
    String(snap.tier || ''),
    String(snap.status || 'done'),
    JSON.stringify(snap.flags || {}),
    snap.entry != null ? String(snap.entry) : null,
    verdict,
    scoreCombined,
    summary ? JSON.stringify(summary) : null,
    snap.reportPath || null,
    snap.chartPath || null,
    snap.preview != null ? String(snap.preview).slice(0, 50000) : null,
    snap.command || null,
    snap.exitCode != null ? Number(snap.exitCode) : null,
    snap.error || null,
  ];

  const info = e.run(sql, params);
  return { id: Number(info.lastInsertRowid) };
}

/**
 * @param {{ page?: number, pageSize?: number, market?: string|null }} opts
 */
async function listHistory(opts = {}) {
  const e = await getEngine();
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(opts.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const market =
    opts.market && ['btc', 'us30'].includes(String(opts.market).toLowerCase())
      ? String(opts.market).toLowerCase()
      : null;

  let total;
  let rows;
  if (market) {
    total = e.get(
      `SELECT COUNT(*) AS c FROM signal_history WHERE market = ?`,
      [market]
    );
    rows = e.all(
      `SELECT id, created_at, started_at, finished_at, market, tier, status,
              flags_json, entry, verdict, score_combined, error
       FROM signal_history
       WHERE market = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [market, pageSize, offset]
    );
  } else {
    total = e.get(`SELECT COUNT(*) AS c FROM signal_history`);
    rows = e.all(
      `SELECT id, created_at, started_at, finished_at, market, tier, status,
              flags_json, entry, verdict, score_combined, error
       FROM signal_history
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
  const row = e.get(`SELECT * FROM signal_history WHERE id = ?`, [n]);
  return rowToDetail(row);
}

async function deleteById(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { deleted: 0 };
  const info = e.run(`DELETE FROM signal_history WHERE id = ?`, [n]);
  return { deleted: Number(info.changes || 0) };
}

async function clearAll() {
  const e = await getEngine();
  const info = e.run(`DELETE FROM signal_history`);
  return { deleted: Number(info.changes || 0) };
}

async function init() {
  await getEngine();
}

module.exports = {
  init,
  insertSnapshot,
  listHistory,
  getById,
  deleteById,
  clearAll,
  getBackendKind,
  _resetForTests,
  get DATA_DIR() {
    return getDataDir();
  },
  get DB_PATH() {
    return getDbPath();
  },
};
