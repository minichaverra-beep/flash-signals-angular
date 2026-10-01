/**
 * Hive box / caja local — almacén embebido SQLite para historial de señales.
 * Preferencia: better-sqlite3. Fallback: sql.js (WASM, sin nativos) si falla en Windows.
 * Archivo: data/signals-history.sqlite (gitignored).
 */
const fs = require('node:fs');
const path = require('node:path');

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
  db.pragma('foreign_keys = ON');
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
  db.exec('PRAGMA foreign_keys = ON;');
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
      if (params?.length) stmt.bind(params);
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
      if (params?.length) stmt.bind(params);
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
 * Migración que solo añade columnas a signal_history (si faltan) y se registra.
 * @param {Array<[string, string]>} columns [nombre, tipo SQL]
 */
function applyAddColumnsMigration(e, migrationId, now, columns) {
  const done = e.get(`SELECT id FROM schema_migrations WHERE id = ?`, [migrationId]);
  if (done) return;
  const cols = e.all(`PRAGMA table_info(signal_history)`) || [];
  const names = new Set(cols.map((c) => String(c.name)));
  for (const [name, type] of columns) {
    if (!names.has(name)) {
      e.run(`ALTER TABLE signal_history ADD COLUMN ${name} ${type}`);
    }
  }
  e.run(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
    [migrationId, now]
  );
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

  applyAddColumnsMigration(e, '002_history_comment_resultado', now, [
    ['comment', 'TEXT'],
    ['resultado', 'TEXT'],
  ]);
  applyAddColumnsMigration(e, '003_history_result_image', now, [
    ['result_image_name', 'TEXT'],
    ['result_image_mime', 'TEXT'],
  ]);
  applyAddColumnsMigration(e, '004_history_pnl_usd', now, [['pnl_usd', 'REAL']]);

  // 005: documenta valor canónico 'no_tomada' en resultado (TEXT; sin ALTER).
  e.run(
    `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
    ['005_history_resultado_no_tomada', now]
  );

  // 006: catálogo history_tags + junction + seed durable (incl. Dirección).
  const has006 = e.get(
    `SELECT id FROM schema_migrations WHERE id = ?`,
    ['006_history_tags']
  );
  if (!has006) {
    e.run(`
      CREATE TABLE IF NOT EXISTS history_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    e.run(`
      CREATE INDEX IF NOT EXISTS idx_history_tags_sort
        ON history_tags (sort_order ASC, id ASC)
    `);
    e.run(`
      CREATE TABLE IF NOT EXISTS signal_history_tags (
        history_id INTEGER NOT NULL REFERENCES signal_history(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES history_tags(id) ON DELETE CASCADE,
        PRIMARY KEY (history_id, tag_id)
      )
    `);
    e.run(`
      CREATE INDEX IF NOT EXISTS idx_signal_history_tags_tag
        ON signal_history_tags (tag_id)
    `);
    e.run(
      `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['006_history_tags', now]
    );
  }

  // 007: motivo de entrada/salida (texto libre del trader).
  const has007 = e.get(
    `SELECT id FROM schema_migrations WHERE id = ?`,
    ['007_history_motivo_entrada_salida']
  );
  if (!has007) {
    const cols = e.all(`PRAGMA table_info(signal_history)`) || [];
    const names = new Set(cols.map((c) => String(c.name)));
    if (!names.has('motivo_entrada_salida')) {
      e.run(`ALTER TABLE signal_history ADD COLUMN motivo_entrada_salida TEXT`);
    }
    e.run(
      `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['007_history_motivo_entrada_salida', now]
    );
  }

  // 008: catálogo history_confluencias + junction (multi-select, separado de Dirección/tags).
  const has008 = e.get(
    `SELECT id FROM schema_migrations WHERE id = ?`,
    ['008_history_confluencias']
  );
  if (!has008) {
    e.run(`
      CREATE TABLE IF NOT EXISTS history_confluencias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    e.run(`
      CREATE INDEX IF NOT EXISTS idx_history_confluencias_sort
        ON history_confluencias (sort_order ASC, id ASC)
    `);
    e.run(`
      CREATE TABLE IF NOT EXISTS signal_history_confluencias (
        history_id INTEGER NOT NULL REFERENCES signal_history(id) ON DELETE CASCADE,
        confluencia_id INTEGER NOT NULL REFERENCES history_confluencias(id) ON DELETE CASCADE,
        PRIMARY KEY (history_id, confluencia_id)
      )
    `);
    e.run(`
      CREATE INDEX IF NOT EXISTS idx_signal_history_confluencias_cf
        ON signal_history_confluencias (confluencia_id)
    `);
    e.run(
      `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['008_history_confluencias', now]
    );
  }

  // 009: barras horizontales de cambio de cálculo (corte viejo vs nuevo en el grid).
  const has009 = e.get(
    `SELECT id FROM schema_migrations WHERE id = ?`,
    ['009_calc_change_markers']
  );
  if (!has009) {
    e.run(`
      CREATE TABLE IF NOT EXISTS calc_change_markers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        title TEXT NOT NULL,
        comment TEXT,
        market TEXT
      )
    `);
    e.run(`
      CREATE INDEX IF NOT EXISTS idx_calc_change_markers_created
        ON calc_change_markers (created_at DESC)
    `);
    // Seed: cambios de esta sesión (Entry/SL/TP + acuerdo→prob + tasa realista)
    e.run(
      `INSERT INTO calc_change_markers (created_at, title, comment, market)
       VALUES (?, ?, ?, NULL)`,
      [
        now,
        'Cálculo v3 — bias + Premium/Discount + acuerdo + tasa',
        [
          '• Entry/SL/TP: LONG no ancla SL a resistencia; daytrader ≤60 pips del spot.',
          '• Probabilidad de éxito: bias H1/CLI + Premium/Discount + blend 62/38 Acuerdo.',
          '• Tasa de acierto: curva reglas + zona PD + bias + acuerdo (techo 74%).',
          'Señales ENCIMA de esta barra usan el cálculo nuevo. Debajo = histórico anterior.',
        ].join('\n'),
      ]
    );
    e.run(
      `INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['009_calc_change_markers', now]
    );
  }
  seedDefaultHistoryTags(e, now);
  seedDefaultHistoryConfluencias(e, now);
}

/** Seed durable de etiquetas Dirección (ex-Tags; INSERT OR IGNORE por name). */
const DEFAULT_HISTORY_TAGS = [
  { name: 'En descuento', color: '#78716c', sortOrder: 10 },
  { name: 'Pre-equilibrio', color: '#166534', sortOrder: 20 },
  { name: 'Premium', color: '#6b7280', sortOrder: 30 },
  { name: 'Macro-Pre-equilibrio', color: '#7c3aed', sortOrder: 40 },
  { name: 'Test', color: '#be185d', sortOrder: 50 },
  { name: 'Dirección', color: '#2563eb', sortOrder: 60 },
];

/**
 * Seed durable de Confluencias (Notion-style). Colores aproximados al picker del usuario.
 * Solo INSERT OR IGNORE — no borra opciones creadas por el usuario.
 */
const DEFAULT_HISTORY_CONFLUENCIAS = [
  { name: 'Continuación', color: '#2563eb', sortOrder: 10 },
  { name: 'Reversion', color: '#6b7280', sortOrder: 20 },
  { name: 'Macro tendencia', color: '#ea580c', sortOrder: 30 },
  { name: 'Micro tendencia', color: '#f87171', sortOrder: 40 },
  { name: 'Resistencia débil', color: '#9333ea', sortOrder: 50 },
  { name: 'Soporte débil', color: '#a16207', sortOrder: 60 },
  { name: 'Pre-Entrada', color: '#db2777', sortOrder: 70 },
  { name: 'FakeOut', color: '#92400e', sortOrder: 80 },
  { name: 'Pullback', color: '#16a34a', sortOrder: 90 },
  { name: 'All', color: '#4b5563', sortOrder: 100 },
  { name: 'Tope ganancia enemiga', color: '#1f2937', sortOrder: 110 },
  { name: 'Pool-liquidez', color: '#0f766e', sortOrder: 120 },
  { name: 'Pullback-Continuo', color: '#92700c', sortOrder: 130 },
];

function seedDefaultHistoryTags(e, nowIso) {
  const now = nowIso || new Date().toISOString();
  for (const tag of DEFAULT_HISTORY_TAGS) {
    e.run(
      `INSERT OR IGNORE INTO history_tags (name, color, sort_order, created_at)
       VALUES (?, ?, ?, ?)`,
      [tag.name, tag.color, tag.sortOrder, now]
    );
  }
}

function seedDefaultHistoryConfluencias(e, nowIso) {
  const now = nowIso || new Date().toISOString();
  for (const item of DEFAULT_HISTORY_CONFLUENCIAS) {
    e.run(
      `INSERT OR IGNORE INTO history_confluencias (name, color, sort_order, created_at)
       VALUES (?, ?, ?, ?)`,
      [item.name, item.color, item.sortOrder, now]
    );
  }
}

/** Valores persistidos: NULL | ganada | perdida | no_tomada */
const RESULTADO_OK = new Set(['ganada', 'perdida', 'no_tomada']);

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
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '_');
  if (s === 'win' || s === 'winning' || s === 'won') return 'ganada';
  if (s === 'lose' || s === 'loss' || s === 'lost') return 'perdida';
  if (
    s === 'no_tomada' ||
    s === 'no-tomada' ||
    s === 'notomada' ||
    s === 'skipped' ||
    s === 'skip'
  ) {
    return 'no_tomada';
  }
  if (RESULTADO_OK.has(s)) return s;
  return undefined; // invalid
}

/**
 * PnL en USD (nullable). '' / null limpia; número o string parseable → float.
 * @returns {number|null|undefined} undefined = inválido
 */
function normalizePnlUsd(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return undefined;
    return Math.round(raw * 100) / 100;
  }
  const s = String(raw).trim().replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  // Permite "$123.45", "+50", "-12.5"
  const cleaned = s.replace(/^\$/, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100) / 100;
}

function readPnlUsd(row) {
  if (row?.pnl_usd == null || row.pnl_usd === '') return null;
  const n = Number(row.pnl_usd);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
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

function rowToTag(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name),
    color: row.color != null && String(row.color).trim() ? String(row.color) : null,
    sortOrder: Number(row.sort_order) || 0,
    createdAt: row.created_at || null,
  };
}

/** Misma forma que Tag; catálogo Confluencias. */
function rowToConfluencia(row) {
  return rowToTag(row);
}

/**
 * Carga tags asignados a varias filas de historial (mapa historyId → Tag[]).
 * @param {any} e
 * @param {number[]} historyIds
 */
function loadTagsByHistoryIds(e, historyIds) {
  /** @type {Map<number, object[]>} */
  const map = new Map();
  const ids = (historyIds || [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return map;
  for (const id of ids) map.set(id, []);
  const placeholders = ids.map(() => '?').join(',');
  const rows = e.all(
    `SELECT sht.history_id AS history_id,
            ht.id, ht.name, ht.color, ht.sort_order, ht.created_at
     FROM signal_history_tags sht
     INNER JOIN history_tags ht ON ht.id = sht.tag_id
     WHERE sht.history_id IN (${placeholders})
     ORDER BY ht.sort_order ASC, ht.id ASC`,
    ids
  );
  for (const row of rows || []) {
    const hid = Number(row.history_id);
    const list = map.get(hid);
    if (list) list.push(rowToTag(row));
  }
  return map;
}

/**
 * Carga confluencias asignadas (mapa historyId → Confluencia[]).
 * @param {any} e
 * @param {number[]} historyIds
 */
function loadConfluenciasByHistoryIds(e, historyIds) {
  /** @type {Map<number, object[]>} */
  const map = new Map();
  const ids = (historyIds || [])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return map;
  for (const id of ids) map.set(id, []);
  const placeholders = ids.map(() => '?').join(',');
  const rows = e.all(
    `SELECT shc.history_id AS history_id,
            hc.id, hc.name, hc.color, hc.sort_order, hc.created_at
     FROM signal_history_confluencias shc
     INNER JOIN history_confluencias hc ON hc.id = shc.confluencia_id
     WHERE shc.history_id IN (${placeholders})
     ORDER BY hc.sort_order ASC, hc.id ASC`,
    ids
  );
  for (const row of rows || []) {
    const hid = Number(row.history_id);
    const list = map.get(hid);
    if (list) list.push(rowToConfluencia(row));
  }
  return map;
}

async function listTags() {
  const e = await getEngine();
  seedDefaultHistoryTags(e);
  const rows = e.all(
    `SELECT id, name, color, sort_order, created_at
     FROM history_tags
     ORDER BY sort_order ASC, id ASC`
  );
  return (rows || []).map(rowToTag);
}

async function listConfluencias() {
  const e = await getEngine();
  seedDefaultHistoryConfluencias(e);
  const rows = e.all(
    `SELECT id, name, color, sort_order, created_at
     FROM history_confluencias
     ORDER BY sort_order ASC, id ASC`
  );
  return (rows || []).map(rowToConfluencia);
}

/**
 * Crea etiqueta durable (o reutiliza si ya existe por name, case-insensitive).
 * @param {{ name: string, color?: string|null, sortOrder?: number }} input
 */
async function createTag(input = {}) {
  const e = await getEngine();
  const name = input.name != null ? String(input.name).trim() : '';
  if (!name || name.length > 80) {
    return { ok: false, error: 'name inválido (1–80 caracteres)' };
  }
  const color =
    input.color != null && String(input.color).trim()
      ? String(input.color).trim().slice(0, 32)
      : null;
  const sortOrder =
    input.sortOrder != null && Number.isFinite(Number(input.sortOrder))
      ? Math.trunc(Number(input.sortOrder))
      : 100;
  const existing = e.get(
    `SELECT id, name, color, sort_order, created_at
     FROM history_tags WHERE lower(name) = lower(?)`,
    [name]
  );
  if (existing) {
    return { ok: true, tag: rowToTag(existing), created: false };
  }
  const now = new Date().toISOString();
  const info = e.run(
    `INSERT INTO history_tags (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)`,
    [name, color, sortOrder, now]
  );
  const row = e.get(
    `SELECT id, name, color, sort_order, created_at FROM history_tags WHERE id = ?`,
    [Number(info.lastInsertRowid)]
  );
  return { ok: true, tag: rowToTag(row), created: true };
}

/**
 * Crea confluencia durable (o reutiliza por name case-insensitive).
 * @param {{ name: string, color?: string|null, sortOrder?: number }} input
 */
async function createConfluencia(input = {}) {
  const e = await getEngine();
  const name = input.name != null ? String(input.name).trim() : '';
  if (!name || name.length > 80) {
    return { ok: false, error: 'name inválido (1–80 caracteres)' };
  }
  const color =
    input.color != null && String(input.color).trim()
      ? String(input.color).trim().slice(0, 32)
      : null;
  const sortOrder =
    input.sortOrder != null && Number.isFinite(Number(input.sortOrder))
      ? Math.trunc(Number(input.sortOrder))
      : 200;
  const existing = e.get(
    `SELECT id, name, color, sort_order, created_at
     FROM history_confluencias WHERE lower(name) = lower(?)`,
    [name]
  );
  if (existing) {
    return { ok: true, confluencia: rowToConfluencia(existing), created: false };
  }
  const now = new Date().toISOString();
  const info = e.run(
    `INSERT INTO history_confluencias (name, color, sort_order, created_at) VALUES (?, ?, ?, ?)`,
    [name, color, sortOrder, now]
  );
  const row = e.get(
    `SELECT id, name, color, sort_order, created_at FROM history_confluencias WHERE id = ?`,
    [Number(info.lastInsertRowid)]
  );
  return { ok: true, confluencia: rowToConfluencia(row), created: true };
}

/**
 * Reemplaza el set de tags de una fila (Dirección: single-select en UI).
 * @param {any} e
 * @param {number} historyId
 * @param {unknown} rawIds
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function replaceHistoryTags(e, historyId, rawIds) {
  if (!Array.isArray(rawIds)) {
    return { ok: false, error: 'tagIds debe ser un array de ids' };
  }
  const ids = [];
  const seen = new Set();
  for (const raw of rawIds) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'tagIds contiene id inválido' };
    }
    if (!seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  for (const tid of ids) {
    const exists = e.get(`SELECT id FROM history_tags WHERE id = ?`, [tid]);
    if (!exists) {
      return { ok: false, error: `tag id ${tid} no existe` };
    }
  }
  e.run(`DELETE FROM signal_history_tags WHERE history_id = ?`, [historyId]);
  for (const tid of ids) {
    e.run(
      `INSERT INTO signal_history_tags (history_id, tag_id) VALUES (?, ?)`,
      [historyId, tid]
    );
  }
  return { ok: true };
}

/**
 * Reemplaza el set de confluencias de una fila (multi-select).
 * @param {any} e
 * @param {number} historyId
 * @param {unknown} rawIds
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function replaceHistoryConfluencias(e, historyId, rawIds) {
  if (!Array.isArray(rawIds)) {
    return { ok: false, error: 'confluenceIds debe ser un array de ids' };
  }
  const ids = [];
  const seen = new Set();
  for (const raw of rawIds) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: 'confluenceIds contiene id inválido' };
    }
    if (!seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  for (const cid of ids) {
    const exists = e.get(`SELECT id FROM history_confluencias WHERE id = ?`, [cid]);
    if (!exists) {
      return { ok: false, error: `confluencia id ${cid} no existe` };
    }
  }
  e.run(`DELETE FROM signal_history_confluencias WHERE history_id = ?`, [historyId]);
  for (const cid of ids) {
    e.run(
      `INSERT INTO signal_history_confluencias (history_id, confluencia_id) VALUES (?, ?)`,
      [historyId, cid]
    );
  }
  return { ok: true };
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

/** Nivel de precio del plan → number finito o null. */
function readPlanLevel(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** String recortado o null si vacío / nullish. */
function trimOrNull(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s || null;
}

/** String original (sin recortar) o null si solo espacios. */
function textOrNull(raw) {
  return trimOrNull(raw) == null ? null : String(raw);
}

function readResultado(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase();
  return RESULTADO_OK.has(s) ? s : null;
}

function readScore(raw) {
  return raw != null && raw !== '' ? Number(raw) : null;
}

function rowToListItem(row) {
  if (!row) return null;
  const flags = parseJson(row.flags_json, {});
  const summaryBias = trimOrNull(row.summary_bias);
  const winrate = trimOrNull(row.summary_winrate);
  const plannedRr = trimOrNull(row.summary_planned_rr);
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    market: row.market,
    tier: row.tier,
    status: row.status,
    verdict: row.verdict || null,
    scoreCombined: readScore(row.score_combined),
    entry: row.entry || null,
    error: row.error || null,
    flags,
    bias: resolveBias(flags, summaryBias),
    /** Tasa de acierto / patrón ganador (summary.winrate), no veredicto wait/stop. */
    winrate,
    /** R:R del plan (summary.planDetails.rr) para métricas del historial. */
    plannedRr,
    /** Niveles del plan (summary.planDetails) para la vista resumida tipo MT5. */
    plannedEntry: readPlanLevel(row.summary_planned_entry),
    plannedSl: readPlanLevel(row.summary_planned_sl),
    plannedTp: readPlanLevel(row.summary_planned_tp),
    comment: textOrNull(row.comment),
    /** Motivo de entrada/salida (nullable; editable desde /historial). */
    motivoEntradaSalida: textOrNull(row.motivo_entrada_salida),
    resultado: readResultado(row.resultado),
    /** PnL real en USD (nullable; editable desde /historial). */
    pnlUsd: readPnlUsd(row),
    hasResultImage: trimOrNull(row.result_image_name) != null,
    resultImageMime: trimOrNull(row.result_image_mime),
    /** Ruta del chart anotado del detalle (si la corrida lo generó). */
    chartPath: trimOrNull(row.chart_path),
    tags: Array.isArray(row._tags) ? row._tags : [],
    confluencias: Array.isArray(row._confluencias) ? row._confluencias : [],
  };
}

function rowToDetail(row) {
  if (!row) return null;
  const summary = parseJson(row.summary_json, null);
  const base = rowToListItem({
    ...row,
    summary_bias: summary?.bias ?? row.summary_bias ?? null,
    summary_winrate: summary?.winrate ?? row.summary_winrate ?? null,
    summary_planned_rr:
      summary?.planDetails?.rr ?? row.summary_planned_rr ?? null,
    summary_planned_entry:
      summary?.planDetails?.entry ?? row.summary_planned_entry ?? null,
    summary_planned_sl: summary?.planDetails?.sl ?? row.summary_planned_sl ?? null,
    summary_planned_tp: summary?.planDetails?.tp ?? row.summary_planned_tp ?? null,
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

/** sortBy permitido → expresión SQL (whitelist: nunca interpolar input del cliente). */
const HISTORY_SORT_SQL = {
  createdAt: 'created_at',
  id: 'id',
  market: 'market',
  bias: "json_extract(summary_json, '$.bias')",
  winrate: "CAST(LTRIM(json_extract(summary_json, '$.winrate'), '~ ') AS REAL)",
  scoreCombined: 'score_combined',
  status: 'status',
  comment: "LOWER(NULLIF(TRIM(comment), ''))",
  resultado: "NULLIF(resultado, '')",
  pnlUsd: 'pnl_usd',
  hasResultImage: 'CASE WHEN result_image_name IS NULL THEN 0 ELSE 1 END',
  plannedEntry: "CAST(json_extract(summary_json, '$.planDetails.entry') AS REAL)",
  plannedSl: "CAST(json_extract(summary_json, '$.planDetails.sl') AS REAL)",
  plannedTp: "CAST(json_extract(summary_json, '$.planDetails.tp') AS REAL)",
  // R:R guardado como "1:2" o número: ordenar por la parte de reward
  plannedRr:
    "CAST(SUBSTR(json_extract(summary_json, '$.planDetails.rr'), " +
    "INSTR(json_extract(summary_json, '$.planDetails.rr'), ':') + 1) AS REAL)",
};

function historyOrderBy(sortBy, sortDir) {
  const expr = HISTORY_SORT_SQL[sortBy] || HISTORY_SORT_SQL.createdAt;
  const dir = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // Vacíos siempre al final, en asc y desc
  return `(${expr}) IS NULL, ${expr} ${dir}, id ${dir}`;
}

/**
 * @param {{ page?: number, pageSize?: number, market?: string|null,
 *   sortBy?: string, sortDir?: 'asc'|'desc' }} opts
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
  const orderBy = historyOrderBy(opts.sortBy, opts.sortDir);

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
              pnl_usd, motivo_entrada_salida, result_image_name, result_image_mime,
              chart_path,
              json_extract(summary_json, '$.bias') AS summary_bias,
              json_extract(summary_json, '$.winrate') AS summary_winrate,
              json_extract(summary_json, '$.planDetails.rr') AS summary_planned_rr,
              json_extract(summary_json, '$.planDetails.entry') AS summary_planned_entry,
              json_extract(summary_json, '$.planDetails.sl') AS summary_planned_sl,
              json_extract(summary_json, '$.planDetails.tp') AS summary_planned_tp
       FROM signal_history
       WHERE market = ?
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [market, pageSize, offset]
    );
  } else {
    total = e.get(`SELECT COUNT(*) AS c FROM signal_history`);
    rows = e.all(
      `SELECT id, created_at, started_at, finished_at, market, tier, status,
              flags_json, entry, verdict, score_combined, error, comment, resultado,
              pnl_usd, motivo_entrada_salida, result_image_name, result_image_mime,
              chart_path,
              json_extract(summary_json, '$.bias') AS summary_bias,
              json_extract(summary_json, '$.winrate') AS summary_winrate,
              json_extract(summary_json, '$.planDetails.rr') AS summary_planned_rr,
              json_extract(summary_json, '$.planDetails.entry') AS summary_planned_entry,
              json_extract(summary_json, '$.planDetails.sl') AS summary_planned_sl,
              json_extract(summary_json, '$.planDetails.tp') AS summary_planned_tp
       FROM signal_history
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
  }

  const count = Number(total?.c ?? 0);
  const items = (rows || []).map(rowToListItem);
  const ids = items.map((i) => i.id);
  const tagMap = loadTagsByHistoryIds(e, ids);
  const confMap = loadConfluenciasByHistoryIds(e, ids);
  for (const item of items) {
    item.tags = tagMap.get(item.id) || [];
    item.confluencias = confMap.get(item.id) || [];
  }
  let calcMarkers = [];
  try {
    calcMarkers = await listCalcMarkers({ market });
  } catch {
    calcMarkers = [];
  }
  return {
    items,
    calcMarkers,
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
  const detail = rowToDetail(row);
  if (!detail) return null;
  const tagMap = loadTagsByHistoryIds(e, [detail.id]);
  const confMap = loadConfluenciasByHistoryIds(e, [detail.id]);
  detail.tags = tagMap.get(detail.id) || [];
  detail.confluencias = confMap.get(detail.id) || [];
  return detail;
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
 * Actualiza anotaciones del trader (comment / motivo / resultado / pnlUsd / tagIds / confluenceIds).
 * @param {number} id
 * @param {{ comment?: string|null, motivoEntradaSalida?: string|null, motivo_entrada_salida?: string|null, resultado?: string|null, pnlUsd?: number|string|null, pnl_usd?: number|string|null, pnlMoney?: number|string|null, tagIds?: number[], confluenceIds?: number[], confluenciaIds?: number[] }} patch
 * @returns {Promise<{ ok: boolean, item?: object, error?: string }>}
 */
/** Primer alias presente en el patch → { present, value }. */
function pickAlias(patch, keys) {
  const key = keys.find((k) => Object.hasOwn(patch, k));
  return key ? { present: true, value: patch[key] } : { present: false, value: undefined };
}

/**
 * SET de columnas escalares (comment / motivo / resultado / pnl).
 * @returns {{ sets: string[], params: any[], error?: string }}
 */
function annotationPatchSets(patch) {
  const sets = [];
  const params = [];
  if (Object.hasOwn(patch, 'comment')) {
    sets.push('comment = ?');
    params.push(normalizeComment(patch.comment));
  }
  const motivo = pickAlias(patch, ['motivoEntradaSalida', 'motivo_entrada_salida']);
  if (motivo.present) {
    sets.push('motivo_entrada_salida = ?');
    params.push(normalizeComment(motivo.value));
  }
  if (Object.hasOwn(patch, 'resultado')) {
    const r = normalizeResultado(patch.resultado);
    if (r === undefined) {
      return { sets, params, error: 'resultado inválido (usa ganada|perdida|no_tomada|vacío)' };
    }
    sets.push('resultado = ?');
    params.push(r);
  }
  const pnl = pickAlias(patch, ['pnlUsd', 'pnl_usd', 'pnlMoney']);
  if (pnl.present) {
    const p = normalizePnlUsd(pnl.value);
    if (p === undefined) {
      return { sets, params, error: 'pnlUsd inválido (usa número, p.ej. 125.5 o -40)' };
    }
    sets.push('pnl_usd = ?');
    params.push(p);
  }
  return { sets, params };
}

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

  const hasOwn = (key) => Object.hasOwn(patch, key);

  const parsed = annotationPatchSets(patch);
  if (parsed.error) return { ok: false, error: parsed.error };
  const { sets, params } = parsed;

  const hasTags = hasOwn('tagIds');
  if (hasTags) {
    const tagResult = replaceHistoryTags(e, n, patch.tagIds);
    if (!tagResult.ok) {
      return { ok: false, error: tagResult.error };
    }
  }

  const hasConfluencias = hasOwn('confluenceIds') || hasOwn('confluenciaIds');
  if (hasConfluencias) {
    const raw = hasOwn('confluenceIds')
      ? patch.confluenceIds
      : patch.confluenciaIds;
    const confResult = replaceHistoryConfluencias(e, n, raw);
    if (!confResult.ok) {
      return { ok: false, error: confResult.error };
    }
  }

  if (!sets.length && !hasTags && !hasConfluencias) {
    return { ok: false, error: 'nada que actualizar' };
  }
  if (sets.length) {
    params.push(n);
    e.run(`UPDATE signal_history SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  const item = await getById(n);
  return { ok: true, item };
}

/**
 * Reajusta Entry/SL/TP del plan (summary.planDetails) con los niveles reales de MT5.
 * El plan original de la señal se conserva una sola vez en summary.planOriginal.
 * @param {number} id
 * @param {{ entry?: number|null, sl?: number|null, tp?: number|null }} levels
 */
async function updatePlanLevels(id, levels = {}) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'id inválido' };
  const row = e.get(`SELECT summary_json FROM signal_history WHERE id = ?`, [n]);
  if (!row) return { ok: false, error: 'not_found' };
  const summary = parseJson(row.summary_json, {}) || {};
  const plan = { ...summary.planDetails };
  if (!summary.planOriginal) {
    summary.planOriginal = {
      entry: plan.entry ?? null,
      sl: plan.sl ?? null,
      tp: plan.tp ?? null,
      rr: plan.rr ?? null,
      risk: plan.risk ?? null,
    };
  }
  let changed = false;
  for (const key of ['entry', 'sl', 'tp']) {
    const v = Number(levels[key]);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (Number(plan[key]) !== v) {
      plan[key] = String(v);
      changed = true;
    }
  }
  const [entry, sl, tp] = ['entry', 'sl', 'tp'].map((k) => Number(plan[k]));
  if ([entry, sl, tp].every((v) => Number.isFinite(v) && v > 0)) {
    const dec = Math.max(...[plan.entry, plan.sl, plan.tp].map((v) => (String(v).split('.')[1] || '').length));
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    plan.risk = risk.toFixed(Math.min(dec, 5));
    if (risk > 0) {
      const ratio = reward / risk;
      plan.rr = Math.abs(ratio - Math.round(ratio)) < 0.05 ? `1:${Math.round(ratio)}` : `1:${ratio.toFixed(1)}`;
    }
  }
  summary.planDetails = plan;
  e.run(`UPDATE signal_history SET summary_json = ? WHERE id = ?`, [JSON.stringify(summary), n]);
  return { ok: true, changed, planOriginal: summary.planOriginal };
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

function rowToCalcMarker(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    createdAt: row.created_at,
    title: row.title || '',
    comment: row.comment != null ? String(row.comment) : null,
    market: row.market || null,
  };
}

async function listCalcMarkers(opts = {}) {
  const e = await getEngine();
  const market = opts.market ? String(opts.market).toLowerCase() : null;
  let rows;
  if (market && ['btc', 'us30', 'xauusd'].includes(market)) {
    rows = e.all(
      `SELECT id, created_at, title, comment, market
       FROM calc_change_markers
       WHERE market IS NULL OR lower(market) = ?
       ORDER BY created_at DESC, id DESC`,
      [market]
    );
  } else {
    rows = e.all(
      `SELECT id, created_at, title, comment, market
       FROM calc_change_markers
       ORDER BY created_at DESC, id DESC`
    );
  }
  return (rows || []).map(rowToCalcMarker);
}

async function createCalcMarker({ title, comment, market, createdAt } = {}) {
  const e = await getEngine();
  const t = String(title || '').trim();
  if (!t) {
    return { ok: false, error: 'title requerido' };
  }
  if (t.length > 200) {
    return { ok: false, error: 'title máx. 200 caracteres' };
  }
  const c =
    comment == null || String(comment).trim() === ''
      ? null
      : String(comment).trim().slice(0, 4000);
  let m = null;
  if (market != null && String(market).trim() !== '') {
    m = String(market).trim().toLowerCase();
    if (!['btc', 'us30', 'xauusd'].includes(m)) {
      return { ok: false, error: 'market inválido (btc|us30|xauusd|null)' };
    }
  }
  const at =
    createdAt && String(createdAt).trim()
      ? String(createdAt).trim()
      : new Date().toISOString();
  const info = e.run(
    `INSERT INTO calc_change_markers (created_at, title, comment, market)
     VALUES (?, ?, ?, ?)`,
    [at, t, c, m]
  );
  const id = Number(info.lastInsertRowid || 0);
  const row = e.get(
    `SELECT id, created_at, title, comment, market FROM calc_change_markers WHERE id = ?`,
    [id]
  );
  return { ok: true, marker: rowToCalcMarker(row) };
}

/**
 * SET parciales de un marcador (title / comment / market).
 * @returns {{ sets: string[], params: any[], error?: string }}
 */
function calcMarkerPatchSets(patch) {
  const sets = [];
  const params = [];
  if (Object.hasOwn(patch, 'title')) {
    const t = String(patch.title || '').trim();
    if (!t) return { sets, params, error: 'title vacío' };
    sets.push('title = ?');
    params.push(t.slice(0, 200));
  }
  if (Object.hasOwn(patch, 'comment')) {
    sets.push('comment = ?');
    params.push(trimOrNull(patch.comment)?.slice(0, 4000) ?? null);
  }
  if (Object.hasOwn(patch, 'market')) {
    const m = trimOrNull(patch.market)?.toLowerCase() ?? null;
    if (m && !['btc', 'us30', 'xauusd'].includes(m)) {
      return { sets, params, error: 'market inválido' };
    }
    sets.push('market = ?');
    params.push(m);
  }
  return { sets, params };
}

async function updateCalcMarker(id, patch = {}) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, error: 'id inválido' };
  }
  const existing = e.get(`SELECT id FROM calc_change_markers WHERE id = ?`, [n]);
  if (!existing) {
    return { ok: false, error: 'marcador no encontrado' };
  }
  const parsed = calcMarkerPatchSets(patch);
  if (parsed.error) return { ok: false, error: parsed.error };
  const { sets, params } = parsed;
  if (!sets.length) {
    const row = e.get(
      `SELECT id, created_at, title, comment, market FROM calc_change_markers WHERE id = ?`,
      [n]
    );
    return { ok: true, marker: rowToCalcMarker(row) };
  }
  params.push(n);
  e.run(`UPDATE calc_change_markers SET ${sets.join(', ')} WHERE id = ?`, params);
  const row = e.get(
    `SELECT id, created_at, title, comment, market FROM calc_change_markers WHERE id = ?`,
    [n]
  );
  return { ok: true, marker: rowToCalcMarker(row) };
}

async function deleteCalcMarker(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, deleted: 0, error: 'id inválido' };
  }
  const info = e.run(`DELETE FROM calc_change_markers WHERE id = ?`, [n]);
  return { ok: true, deleted: Number(info.changes || 0) };
}

/**
 * Recalcula Probabilidad (score_combined + summary) de todo el historial
 * con blend acuerdo + penalización ubicación (v2).
 * @param {{ force?: boolean, market?: string|null }} opts
 */
async function recalcAllProbabilidad(opts = {}) {
  const { recalcSummaryProbabilidad, RECALC_VERSION } = require('./recalc-probabilidad');
  const e = await getEngine();
  const force = Boolean(opts.force);
  const market =
    opts.market && ['btc', 'us30', 'xauusd'].includes(String(opts.market).toLowerCase())
      ? String(opts.market).toLowerCase()
      : null;

  const rows = market
    ? e.all(
        `SELECT id, flags_json, summary_json, preview, score_combined
         FROM signal_history WHERE market = ? ORDER BY id ASC`,
        [market]
      )
    : e.all(
        `SELECT id, flags_json, summary_json, preview, score_combined
         FROM signal_history ORDER BY id ASC`
      );

  const counts = { updated: 0, unchanged: 0, skipped: 0 };
  const samples = [];
  const ctx = { e, force, recalcSummaryProbabilidad, RECALC_VERSION };

  for (const row of rows || []) {
    const res = recalcHistoryRow(ctx, row);
    counts[res.status] += 1;
    if (res.sample && samples.length < 8) samples.push(res.sample);
  }

  return {
    ok: true,
    version: RECALC_VERSION,
    total: (rows || []).length,
    ...counts,
    samples,
  };
}

/**
 * Recalcula una fila del historial.
 * @returns {{ status: 'updated'|'unchanged'|'skipped', sample?: object }}
 */
function recalcHistoryRow(ctx, row) {
  const { e, force, recalcSummaryProbabilidad, RECALC_VERSION } = ctx;
  const summary = parseJson(row.summary_json, null);
  if (!summary || typeof summary !== 'object') return { status: 'skipped' };
  // Prefer column if summary missing score
  if (summary.scoreCombined == null && row.score_combined != null) {
    summary.scoreCombined = Number(row.score_combined);
  }
  const out = recalcSummaryProbabilidad(summary, {
    preview: row.preview || null,
    flags: parseJson(row.flags_json, {}),
    force,
  });
  if (out.scoreCombined == null) return { status: 'skipped' };
  if (!out.changed && out.summary.scoreRecalcVersion === RECALC_VERSION && !force) {
    return { status: 'unchanged' };
  }
  e.run(
    `UPDATE signal_history SET score_combined = ?, summary_json = ? WHERE id = ?`,
    [out.scoreCombined, JSON.stringify(out.summary), Number(row.id)]
  );
  return {
    status: 'updated',
    sample: {
      id: Number(row.id),
      before: out.summary.scoreCombinedBeforeRecalc,
      after: out.scoreCombined,
      meta: out.summary.scoreRecalcMeta || null,
      winrate: out.summary.winrate || null,
    },
  };
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
  updatePlanLevels,
  listTags,
  createTag,
  listConfluencias,
  createConfluencia,
  listCalcMarkers,
  createCalcMarker,
  updateCalcMarker,
  deleteCalcMarker,
  recalcAllProbabilidad,
  saveResultImage,
  deleteResultImage,
  getResultImageFile,
  clearAll,
  getBackendKind,
  _resetForTests,
  MAX_RESULT_IMAGE_BYTES,
  DEFAULT_HISTORY_TAGS,
  DEFAULT_HISTORY_CONFLUENCIAS,
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
