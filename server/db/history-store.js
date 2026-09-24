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
  const engine = {
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
  applyHistoryMigrations(engine);
  return engine;
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

  const engine = {
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
  applyHistoryMigrations(engine);
  return engine;
}

/**
 * Migraciones incrementales (CREATE IF NOT EXISTS no altera tablas viejas).
 */
function applyHistoryMigrations(e) {
  const now = new Date().toISOString();
  e.run(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
    ['001_init', now]
  );

  const has002 = e.get(
    `SELECT id FROM schema_migrations WHERE id = ?`,
    ['002_history_comment_resultado']
  );
  if (!has002) {
    const cols = e.all(`PRAGMA table_info(signal_history)`) || [];
    const names = new Set(cols.map((c) => String(c.name)));
    if (!names.has('comment')) {
      e.run(`ALTER TABLE signal_history ADD COLUMN comment TEXT`);
    }
    if (!names.has('resultado')) {
      e.run(`ALTER TABLE signal_history ADD COLUMN resultado TEXT`);
    }
    e.run(
      `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['002_history_comment_resultado', now]
    );
  }

  const has003 = e.get(
    `SELECT id FROM schema_migrations WHERE id = ?`,
    ['003_history_result_image']
  );
  if (!has003) {
    const cols = e.all(`PRAGMA table_info(signal_history)`) || [];
    const names = new Set(cols.map((c) => String(c.name)));
    if (!names.has('result_image_name')) {
      e.run(`ALTER TABLE signal_history ADD COLUMN result_image_name TEXT`);
    }
    if (!names.has('result_image_mime')) {
      e.run(`ALTER TABLE signal_history ADD COLUMN result_image_mime TEXT`);
    }
    e.run(
      `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['003_history_result_image', now]
    );
  }
}

const RESULTADO_OK = new Set(['ganada', 'perdida']);

const IMAGE_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const MAX_RESULT_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

function getAttachmentsDir() {
  return path.join(getDataDir(), 'history-attachments');
}

function ensureAttachmentsDir() {
  const dir = getAttachmentsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function normalizeComment(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.slice(0, 2000);
}

function normalizeResultado(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toLowerCase();
  if (s === 'win' || s === 'winning' || s === 'won') return 'ganada';
  if (s === 'lose' || s === 'loss' || s === 'lost') return 'perdida';
  if (RESULTADO_OK.has(s)) return s;
  return undefined; // invalid
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

/**
 * Bias elegido en la corrida: flags bullish/bearish del job, o summary.bias.
 * @param {Record<string, boolean>|null|undefined} flags
 * @param {string|null|undefined} summaryBias
 */
function resolveBias(flags, summaryBias) {
  if (flags?.bullish) return 'bullish';
  if (flags?.bearish) return 'bearish';
  const fromSummary =
    summaryBias != null && String(summaryBias).trim()
      ? String(summaryBias).trim()
      : null;
  if (fromSummary) return fromSummary;
  if (flags && ('bullish' in flags || 'bearish' in flags)) return 'auto';
  return null;
}

function rowToListItem(row) {
  if (!row) return null;
  const flags = parseJson(row.flags_json, {});
  const summaryBias =
    row.summary_bias != null && String(row.summary_bias).trim()
      ? String(row.summary_bias).trim()
      : null;
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
    flags,
    bias: resolveBias(flags, summaryBias),
    comment: row.comment != null && String(row.comment).trim()
      ? String(row.comment)
      : null,
    resultado:
      row.resultado != null && RESULTADO_OK.has(String(row.resultado).toLowerCase())
        ? String(row.resultado).toLowerCase()
        : null,
    hasResultImage: Boolean(
      row.result_image_name != null && String(row.result_image_name).trim()
    ),
    resultImageMime:
      row.result_image_mime != null && String(row.result_image_mime).trim()
        ? String(row.result_image_mime).trim()
        : null,
  };
}

function rowToDetail(row) {
  if (!row) return null;
  const summary = parseJson(row.summary_json, null);
  const base = rowToListItem({
    ...row,
    summary_bias: summary?.bias ?? row.summary_bias ?? null,
  });
  return {
    ...base,
    summary,
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
    opts.market && ['btc', 'us30', 'xauusd'].includes(String(opts.market).toLowerCase())
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
              flags_json, entry, verdict, score_combined, error, comment, resultado,
              result_image_name, result_image_mime,
              json_extract(summary_json, '$.bias') AS summary_bias
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
              flags_json, entry, verdict, score_combined, error, comment, resultado,
              result_image_name, result_image_mime,
              json_extract(summary_json, '$.bias') AS summary_bias
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
  const existing = e.get(
    `SELECT result_image_name FROM signal_history WHERE id = ?`,
    [n]
  );
  if (existing?.result_image_name) {
    const abs = path.join(
      getAttachmentsDir(),
      String(existing.result_image_name)
    );
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
  const info = e.run(`DELETE FROM signal_history WHERE id = ?`, [n]);
  return { deleted: Number(info.changes || 0) };
}

/**
 * Actualiza anotaciones del trader (comment / resultado).
 * @param {number} id
 * @param {{ comment?: string|null, resultado?: string|null }} patch
 * @returns {Promise<{ ok: boolean, item?: object, error?: string }>}
 */
async function updateAnnotation(id, patch = {}) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: 'id inválido' };
  }
  const existing = e.get(`SELECT id FROM signal_history WHERE id = ?`, [n]);
  if (!existing) {
    return { ok: false, error: 'not_found' };
  }

  const sets = [];
  const params = [];
  if (Object.prototype.hasOwnProperty.call(patch, 'comment')) {
    sets.push('comment = ?');
    params.push(normalizeComment(patch.comment));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'resultado')) {
    const r = normalizeResultado(patch.resultado);
    if (r === undefined) {
      return { ok: false, error: 'resultado inválido (usa ganada|perdida|vacío)' };
    }
    sets.push('resultado = ?');
    params.push(r);
  }
  if (!sets.length) {
    return { ok: false, error: 'nada que actualizar' };
  }
  params.push(n);
  e.run(`UPDATE signal_history SET ${sets.join(', ')} WHERE id = ?`, params);
  const item = await getById(n);
  return { ok: true, item };
}

/**
 * @param {number} id
 * @returns {Promise<{ absPath: string, mime: string } | null>}
 */
async function getResultImageFile(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const row = e.get(
    `SELECT result_image_name, result_image_mime FROM signal_history WHERE id = ?`,
    [n]
  );
  if (!row?.result_image_name) return null;
  const name = String(row.result_image_name);
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return null;
  }
  const absPath = path.join(getAttachmentsDir(), name);
  if (!fs.existsSync(absPath)) return null;
  return {
    absPath,
    mime: row.result_image_mime || 'application/octet-stream',
  };
}

/**
 * Guarda captura del resultado (PNG/JPEG/WebP/GIF).
 * @param {number} id
 * @param {Buffer} buffer
 * @param {string} mime
 */
async function saveResultImage(id, buffer, mime) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: 'id inválido' };
  }
  const existing = e.get(
    `SELECT id, result_image_name FROM signal_history WHERE id = ?`,
    [n]
  );
  if (!existing) {
    return { ok: false, error: 'not_found' };
  }
  const mimeNorm = String(mime || '')
    .trim()
    .toLowerCase()
    .split(';')[0];
  const ext = IMAGE_MIME[mimeNorm];
  if (!ext) {
    return { ok: false, error: 'formato no soportado (usa PNG, JPG, WebP o GIF)' };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) {
    return { ok: false, error: 'imagen vacía o inválida' };
  }
  if (buffer.length > MAX_RESULT_IMAGE_BYTES) {
    return { ok: false, error: 'imagen demasiado grande (máx 5 MB)' };
  }

  const dir = ensureAttachmentsDir();
  // Borra archivo previo si existía
  if (existing.result_image_name) {
    const prev = path.join(dir, String(existing.result_image_name));
    try {
      if (fs.existsSync(prev)) fs.unlinkSync(prev);
    } catch {
      /* ignore */
    }
  }

  const fileName = `${n}-${Date.now()}.${ext}`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, buffer);
  e.run(
    `UPDATE signal_history SET result_image_name = ?, result_image_mime = ? WHERE id = ?`,
    [fileName, mimeNorm === 'image/jpg' ? 'image/jpeg' : mimeNorm, n]
  );
  const item = await getById(n);
  return { ok: true, item };
}

async function deleteResultImage(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: 'id inválido' };
  }
  const existing = e.get(
    `SELECT id, result_image_name FROM signal_history WHERE id = ?`,
    [n]
  );
  if (!existing) {
    return { ok: false, error: 'not_found' };
  }
  if (existing.result_image_name) {
    const abs = path.join(getAttachmentsDir(), String(existing.result_image_name));
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
  e.run(
    `UPDATE signal_history SET result_image_name = NULL, result_image_mime = NULL WHERE id = ?`,
    [n]
  );
  const item = await getById(n);
  return { ok: true, item };
}

async function clearAll() {
  const e = await getEngine();
  // Limpia adjuntos en disco
  const dir = getAttachmentsDir();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  }
  const info = e.run(`DELETE FROM signal_history`);
  return { deleted: Number(info.changes || 0) };
}

async function init() {
  await getEngine();
  ensureAttachmentsDir();
}

module.exports = {
  init,
  insertSnapshot,
  listHistory,
  getById,
  deleteById,
  updateAnnotation,
  saveResultImage,
  deleteResultImage,
  getResultImageFile,
  clearAll,
  getBackendKind,
  _resetForTests,
  MAX_RESULT_IMAGE_BYTES,
  get DATA_DIR() {
    return getDataDir();
  },
  get DB_PATH() {
    return getDbPath();
  },
  get ATTACHMENTS_DIR() {
    return getAttachmentsDir();
  },
};
