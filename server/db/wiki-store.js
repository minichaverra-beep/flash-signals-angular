/**
 * Metadatos locales de la Wiki (display name, categorías).
 * Mismo estilo que history-store: better-sqlite3 con fallback sql.js.
 * Archivo: data/wiki-meta.sqlite (gitignored).
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'wiki-schema.sql');

function getDataDir() {
  return (
    process.env.WIKI_DATA_DIR ||
    process.env.HISTORY_DATA_DIR ||
    path.join(__dirname, '..', '..', 'data')
  );
}

function getDbPath() {
  return path.join(getDataDir(), 'wiki-meta.sqlite');
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
  applyWikiMigrations(engine);
  return engine;
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
  applyWikiMigrations(engine);
  return engine;
}

/**
 * Migraciones incrementales (CREATE IF NOT EXISTS no altera tablas viejas).
 */
function applyWikiMigrations(e) {
  const now = new Date().toISOString();
  e.run(
    `INSERT OR IGNORE INTO wiki_schema_migrations (id, applied_at) VALUES (?, ?)`,
    ['001_wiki_init', now]
  );

  const has002 = e.get(
    `SELECT id FROM wiki_schema_migrations WHERE id = ?`,
    ['002_artifact_bias']
  );
  if (!has002) {
    const cols = e.all(`PRAGMA table_info(artifact_meta)`) || [];
    const hasBias = cols.some((c) => String(c.name) === 'bias');
    if (!hasBias) {
      e.run(`ALTER TABLE artifact_meta ADD COLUMN bias TEXT`);
    }
    e.run(
      `INSERT OR IGNORE INTO wiki_schema_migrations (id, applied_at) VALUES (?, ?)`,
      ['002_artifact_bias', now]
    );
  }
}

async function getEngine() {
  if (engine) return engine;
  ensureDataDir();
  try {
    engine = openBetterSqlite3();
    console.log(`[wiki-meta] → better-sqlite3 (${getDbPath()})`);
    return engine;
  } catch (err) {
    console.warn(
      `[wiki-meta] better-sqlite3 no disponible (${err.message}); usando sql.js`
    );
    engine = await openSqlJs();
    console.log(`[wiki-meta] → sql.js (${getDbPath()})`);
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

function rowToCategory(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: String(row.name),
    sortOrder: Number(row.sort_order) || 0,
    color: row.color != null && row.color !== '' ? String(row.color) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMeta(row) {
  if (!row) return null;
  return {
    path: String(row.path),
    displayName: String(row.display_name),
    categoryId:
      row.category_id != null && row.category_id !== ''
        ? Number(row.category_id)
        : null,
    bias: normalizeStoredBias(row.bias),
    updatedAt: row.updated_at,
  };
}

/**
 * Canoniza bias de artefacto: bullish | bearish | auto | null.
 * No parsea paths ni filenames — solo valores explícitos de meta.
 */
function sanitizeBias(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 'null') return null;
  const t = String(value).trim().toLowerCase();
  if (!t) return null;
  if (t === 'bullish' || t === 'alcista' || t === 'bull') return 'bullish';
  if (t === 'bearish' || t === 'bajista' || t === 'bear') return 'bearish';
  if (
    t === 'auto' ||
    t === 'default' ||
    t === 'neutral' ||
    t === 'none' ||
    t === 'n/a'
  ) {
    return 'auto';
  }
  return null;
}

function normalizeStoredBias(value) {
  const s = sanitizeBias(value);
  return s === undefined ? null : s;
}

function normalizePathKey(relPath) {
  if (relPath == null) return null;
  const s = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!s || s.includes('\0') || s.split('/').some((p) => p === '..' || p === '')) {
    return null;
  }
  return s;
}

/** Extensiones de artefacto conocidas (no se muestran ni se guardan en display_name). */
const DISPLAY_STRIP_EXTS = new Set([
  '.md',
  '.txt',
  '.html',
  '.htm',
  '.json',
  '.csv',
  '.log',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
]);

/**
 * Quita la extensión de archivo conocida del nombre visible.
 * "README.md" → "README"; "v1.2" se conserva.
 */
function stripDisplayExtension(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const ext = path.extname(s).toLowerCase();
  if (ext && DISPLAY_STRIP_EXTS.has(ext)) {
    return s.slice(0, -ext.length);
  }
  return s;
}

function sanitizeDisplayName(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\s+/g, ' ');
  if (!s || s.length > 240) return null;
  if (/[\\/\0]/.test(s)) return null;
  return s;
}

/** display_name de artefacto: sin extensión conocida en el nombre visible. */
function sanitizeArtifactDisplayName(raw) {
  return sanitizeDisplayName(stripDisplayExtension(raw));
}

/**
 * Nombre de archivo seguro a partir del display (opcional rename en disco).
 * Siempre conserva/aplica fallbackExt (el usuario no edita la extensión).
 */
function safeFileBaseName(displayName, fallbackExt) {
  let base = stripDisplayExtension(
    String(displayName)
      .trim()
      .replace(/[<>:"|?*\x00-\x1f\\/]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
  ).slice(0, 180);
  if (!base) return null;
  if (fallbackExt) {
    const ext = fallbackExt.startsWith('.') ? fallbackExt : `.${fallbackExt}`;
    base += ext;
  }
  return base;
}

async function listCategories() {
  const e = await getEngine();
  const rows = e.all(
    `SELECT id, name, sort_order, color, created_at, updated_at
     FROM wiki_categories
     ORDER BY sort_order ASC, id ASC`
  );
  return (rows || []).map(rowToCategory);
}

async function getCategory(id) {
  const e = await getEngine();
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const row = e.get(
    `SELECT id, name, sort_order, color, created_at, updated_at
     FROM wiki_categories WHERE id = ?`,
    [n]
  );
  return rowToCategory(row);
}

async function createCategory({ name, sortOrder, color } = {}) {
  const e = await getEngine();
  const nm = sanitizeDisplayName(name);
  if (!nm) {
    return { ok: false, status: 400, error: 'name inválido' };
  }
  const now = new Date().toISOString();
  const order =
    sortOrder != null && Number.isFinite(Number(sortOrder))
      ? Math.trunc(Number(sortOrder))
      : (e.get(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM wiki_categories`)
          ?.n ?? 0);
  const col =
    color == null || String(color).trim() === ''
      ? null
      : String(color).trim().slice(0, 32);

  const info = e.run(
    `INSERT INTO wiki_categories (name, sort_order, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [nm, Number(order) || 0, col, now, now]
  );
  const id = Number(info.lastInsertRowid);
  return { ok: true, category: await getCategory(id) };
}

async function updateCategory(id, patch = {}) {
  const e = await getEngine();
  const existing = await getCategory(id);
  if (!existing) {
    return { ok: false, status: 404, error: 'Categoría no encontrada' };
  }
  let name = existing.name;
  let sortOrder = existing.sortOrder;
  let color = existing.color;

  if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
    const nm = sanitizeDisplayName(patch.name);
    if (!nm) {
      return { ok: false, status: 400, error: 'name inválido' };
    }
    name = nm;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'sortOrder')) {
    if (!Number.isFinite(Number(patch.sortOrder))) {
      return { ok: false, status: 400, error: 'sortOrder inválido' };
    }
    sortOrder = Math.trunc(Number(patch.sortOrder));
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'color')) {
    color =
      patch.color == null || String(patch.color).trim() === ''
        ? null
        : String(patch.color).trim().slice(0, 32);
  }

  const now = new Date().toISOString();
  e.run(
    `UPDATE wiki_categories
     SET name = ?, sort_order = ?, color = ?, updated_at = ?
     WHERE id = ?`,
    [name, sortOrder, color, now, existing.id]
  );
  return { ok: true, category: await getCategory(existing.id) };
}

/**
 * Borra categoría. Si tiene artefactos:
 * - reassignTo = null → deja category_id NULL
 * - reassignTo = id → mueve a esa categoría
 * - sin reassign y con meta → 409 si no se pide explícitamente vaciar
 */
async function deleteCategory(id, { reassignTo, force } = {}) {
  const e = await getEngine();
  const existing = await getCategory(id);
  if (!existing) {
    return { ok: false, status: 404, error: 'Categoría no encontrada' };
  }
  const countRow = e.get(
    `SELECT COUNT(*) AS c FROM artifact_meta WHERE category_id = ?`,
    [existing.id]
  );
  const count = Number(countRow?.c ?? 0);

  if (count > 0) {
    if (reassignTo === undefined && !force) {
      return {
        ok: false,
        status: 409,
        error: `La categoría tiene ${count} artefacto(s). Usa reassignTo (id o null) o force=true`,
        artifactCount: count,
      };
    }
    if (reassignTo === null || reassignTo === 'null' || force) {
      e.run(`UPDATE artifact_meta SET category_id = NULL WHERE category_id = ?`, [
        existing.id,
      ]);
    } else {
      const target = await getCategory(reassignTo);
      if (!target) {
        return { ok: false, status: 400, error: 'reassignTo no existe' };
      }
      if (target.id === existing.id) {
        return { ok: false, status: 400, error: 'reassignTo no puede ser la misma' };
      }
      e.run(`UPDATE artifact_meta SET category_id = ? WHERE category_id = ?`, [
        target.id,
        existing.id,
      ]);
    }
  }

  const info = e.run(`DELETE FROM wiki_categories WHERE id = ?`, [existing.id]);
  return { ok: true, deleted: Number(info.changes || 0) };
}

async function listMeta() {
  const e = await getEngine();
  const rows = e.all(
    `SELECT path, display_name, category_id, bias, updated_at FROM artifact_meta`
  );
  return (rows || []).map(rowToMeta);
}

async function getMeta(relPath) {
  const e = await getEngine();
  const key = normalizePathKey(relPath);
  if (!key) return null;
  const row = e.get(
    `SELECT path, display_name, category_id, bias, updated_at FROM artifact_meta WHERE path = ?`,
    [key]
  );
  return rowToMeta(row);
}

/**
 * Upsert de meta. categoryId / bias: valor | null | undefined (undefined = no tocar).
 * @returns {{ ok: true, meta: object, pathChanged?: boolean, oldPath?: string } | { ok: false, status: number, error: string }}
 */
async function upsertMeta({
  path: relPath,
  displayName,
  categoryId,
  bias,
  direction,
} = {}) {
  const e = await getEngine();
  const key = normalizePathKey(relPath);
  if (!key) {
    return { ok: false, status: 400, error: 'path inválido' };
  }

  const existing = await getMeta(key);
  let nextDisplay =
    displayName !== undefined
      ? sanitizeArtifactDisplayName(displayName)
      : existing?.displayName || stripDisplayExtension(path.basename(key));
  if (displayName !== undefined && !nextDisplay) {
    return { ok: false, status: 400, error: 'display_name inválido' };
  }
  if (!nextDisplay) {
    nextDisplay = stripDisplayExtension(path.basename(key)) || path.basename(key);
  }

  let nextCat = existing?.categoryId ?? null;
  if (categoryId !== undefined) {
    if (categoryId === null || categoryId === '' || categoryId === 'null') {
      nextCat = null;
    } else {
      const cat = await getCategory(categoryId);
      if (!cat) {
        return { ok: false, status: 400, error: 'category_id no existe' };
      }
      nextCat = cat.id;
    }
  }

  let nextBias = existing?.bias ?? null;
  const biasRaw = bias !== undefined ? bias : direction;
  if (biasRaw !== undefined) {
    const sanitized = sanitizeBias(biasRaw);
    if (
      biasRaw != null &&
      biasRaw !== '' &&
      biasRaw !== 'null' &&
      sanitized === null
    ) {
      return {
        ok: false,
        status: 400,
        error: 'bias inválido (usa bullish/bearish/auto o alcista/bajista/default)',
      };
    }
    nextBias = sanitized;
  }

  const now = new Date().toISOString();
  e.run(
    `INSERT INTO artifact_meta (path, display_name, category_id, bias, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       display_name = excluded.display_name,
       category_id = excluded.category_id,
       bias = excluded.bias,
       updated_at = excluded.updated_at`,
    [key, nextDisplay, nextCat, nextBias, now]
  );
  return { ok: true, meta: await getMeta(key) };
}

/**
 * Tras rename en disco: mueve la fila de meta al nuevo path.
 */
async function moveMetaPath(oldPath, newPath, displayName) {
  const e = await getEngine();
  const from = normalizePathKey(oldPath);
  const to = normalizePathKey(newPath);
  if (!from || !to) {
    return { ok: false, status: 400, error: 'path inválido' };
  }
  const existing = await getMeta(from);
  const now = new Date().toISOString();
  const name =
    sanitizeArtifactDisplayName(displayName) ||
    existing?.displayName ||
    stripDisplayExtension(path.basename(to)) ||
    path.basename(to);
  const cat = existing?.categoryId ?? null;
  const bias = existing?.bias ?? null;

  if (existing) {
    e.run(`DELETE FROM artifact_meta WHERE path = ?`, [from]);
  }
  e.run(
    `INSERT INTO artifact_meta (path, display_name, category_id, bias, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       display_name = excluded.display_name,
       category_id = excluded.category_id,
       bias = excluded.bias,
       updated_at = excluded.updated_at`,
    [to, name, cat, bias, now]
  );
  return { ok: true, meta: await getMeta(to), pathChanged: true, oldPath: from };
}

async function clearAll() {
  const e = await getEngine();
  e.run(`DELETE FROM artifact_meta`);
  const info = e.run(`DELETE FROM wiki_categories`);
  return { deleted: Number(info.changes || 0) };
}

async function init() {
  await getEngine();
}

module.exports = {
  init,
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  listMeta,
  getMeta,
  upsertMeta,
  moveMetaPath,
  normalizePathKey,
  sanitizeDisplayName,
  sanitizeArtifactDisplayName,
  sanitizeBias,
  stripDisplayExtension,
  safeFileBaseName,
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
