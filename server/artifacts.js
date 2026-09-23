/**
 * Escaneo y resolución segura de artefactos bajo docs/Artifacts.
 * Lectura + rename opcional seguro; bloquea path traversal fuera de la raíz.
 */
const fs = require('fs');
const path = require('path');
const wikiStore = require('./db/wiki-store');

const ARTIFACTS_ROOT = path.resolve(
  path.join(__dirname, '..', 'docs', 'Artifacts')
);

const MAX_DEPTH = 6;
const MAX_FILES = 500;

const IGNORE_NAMES = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.git',
  'node_modules',
  '.tmp',
  '.temp',
]);

const IGNORE_SUFFIXES = ['.tmp', '.temp', '.swp', '.bak', '~'];

const TEXT_EXTS = new Set(['.md', '.txt', '.html', '.htm', '.json', '.csv', '.log']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const BINARY_PREVIEW = new Set(['.pdf', ...IMAGE_EXTS]);

const MIME = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function ensureRoot() {
  if (!fs.existsSync(ARTIFACTS_ROOT)) {
    fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });
  }
  return ARTIFACTS_ROOT;
}

function shouldIgnore(name) {
  const lower = String(name).toLowerCase();
  if (IGNORE_NAMES.has(lower)) return true;
  if (lower.startsWith('.')) return true;
  return IGNORE_SUFFIXES.some((s) => lower.endsWith(s));
}

function kindForExt(ext) {
  const e = ext.toLowerCase();
  if (e === '.md') return 'markdown';
  if (e === '.html' || e === '.htm') return 'html';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (e === '.pdf') return 'pdf';
  if (TEXT_EXTS.has(e)) return 'text';
  return 'other';
}

/**
 * Resuelve una ruta relativa segura bajo ARTIFACTS_ROOT.
 * @returns {{ ok: true, full: string, rel: string } | { ok: false, status: number, error: string }}
 */
function resolveSafe(relPath) {
  ensureRoot();
  if (relPath == null || String(relPath).trim() === '') {
    return { ok: false, status: 400, error: 'path requerido' };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(String(relPath));
  } catch {
    return { ok: false, status: 400, error: 'path inválido (encoding)' };
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    normalized.includes('\0') ||
    normalized.split('/').some((p) => p === '..' || p === '')
  ) {
    return { ok: false, status: 400, error: 'path traversal bloqueado' };
  }
  const full = path.resolve(path.join(ARTIFACTS_ROOT, ...normalized.split('/')));
  const rootWithSep = ARTIFACTS_ROOT.toLowerCase() + path.sep;
  const under =
    full.toLowerCase() === ARTIFACTS_ROOT.toLowerCase() ||
    full.toLowerCase().startsWith(rootWithSep);
  if (!under) {
    return { ok: false, status: 400, error: 'path fuera de docs/Artifacts' };
  }
  return {
    ok: true,
    full,
    rel: path.relative(ARTIFACTS_ROOT, full).split(path.sep).join('/'),
  };
}

function toPosixRel(fromRoot, full) {
  return path.relative(fromRoot, full).split(path.sep).join('/');
}

/**
 * Escaneo recursivo fresco (sin caché). Sin meta DB.
 */
function scanArtifactsDisk() {
  const root = ensureRoot();
  const items = [];
  let truncated = false;

  function walk(dir, depth) {
    if (truncated || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (truncated) break;
      if (shouldIgnore(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      const rel = toPosixRel(root, full);
      items.push({
        name: ent.name,
        path: rel,
        ext: ext || '',
        size: st.size,
        mtime: st.mtime.toISOString(),
        kind: kindForExt(ext),
        displayName:
          wikiStore.stripDisplayExtension(ent.name) || ent.name,
        categoryId: null,
      });
      if (items.length >= MAX_FILES) {
        truncated = true;
        break;
      }
    }
  }

  walk(root, 0);
  items.sort((a, b) => {
    const t = String(b.mtime).localeCompare(String(a.mtime));
    return t !== 0 ? t : a.path.localeCompare(b.path);
  });

  return {
    root: 'docs/Artifacts',
    exists: true,
    count: items.length,
    truncated,
    scannedAt: new Date().toISOString(),
    items,
  };
}

/**
 * Escaneo + merge con artifact_meta (displayName / categoryId).
 */
async function scanArtifacts() {
  const data = scanArtifactsDisk();
  let metaList = [];
  let categories = [];
  try {
    metaList = await wikiStore.listMeta();
    categories = await wikiStore.listCategories();
  } catch (err) {
    console.warn('[artifacts] wiki-meta no disponible:', err.message);
  }
  const byPath = new Map(metaList.map((m) => [m.path, m]));
  data.items = data.items.map((item) => {
    const meta = byPath.get(item.path);
    if (!meta) return item;
    const raw = meta.displayName || item.name;
    return {
      ...item,
      displayName: wikiStore.stripDisplayExtension(raw) || raw,
      categoryId: meta.categoryId,
      metaUpdatedAt: meta.updatedAt,
    };
  });
  data.categories = categories;
  return data;
}

async function readArtifactMeta(relPath) {
  const resolved = resolveSafe(relPath);
  if (!resolved.ok) return resolved;
  let st;
  try {
    st = fs.statSync(resolved.full);
  } catch {
    return { ok: false, status: 404, error: 'Artefacto no encontrado' };
  }
  if (!st.isFile()) {
    return { ok: false, status: 404, error: 'Artefacto no encontrado' };
  }
  const ext = path.extname(resolved.full).toLowerCase();
  const kind = kindForExt(ext);
  const mime = MIME[ext] || 'application/octet-stream';
  const fileName = path.basename(resolved.full);
  let displayName = wikiStore.stripDisplayExtension(fileName) || fileName;
  let categoryId = null;
  let metaUpdatedAt = null;
  try {
    const dbMeta = await wikiStore.getMeta(resolved.rel);
    if (dbMeta) {
      const raw = dbMeta.displayName || fileName;
      displayName = wikiStore.stripDisplayExtension(raw) || raw;
      categoryId = dbMeta.categoryId;
      metaUpdatedAt = dbMeta.updatedAt;
    }
  } catch {
    /* ignore */
  }
  const meta = {
    name: fileName,
    displayName,
    categoryId,
    metaUpdatedAt,
    path: resolved.rel,
    ext,
    size: st.size,
    mtime: st.mtime.toISOString(),
    kind,
    mime,
    rawUrl: `/api/artifacts/raw?path=${encodeURIComponent(resolved.rel)}`,
  };

  if (TEXT_EXTS.has(ext)) {
    const content = fs.readFileSync(resolved.full, 'utf8');
    return { ok: true, ...meta, content };
  }
  return {
    ok: true,
    ...meta,
    content: null,
    note: BINARY_PREVIEW.has(ext)
      ? 'Usar rawUrl para preview/descarga'
      : 'Binario; abrir via rawUrl',
  };
}

/**
 * Renombra el archivo en disco de forma segura (mismo directorio).
 * @returns {{ ok: true, oldPath: string, path: string, full: string } | { ok: false, status: number, error: string }}
 */
function renameArtifactFile(relPath, newBaseName) {
  const resolved = resolveSafe(relPath);
  if (!resolved.ok) return resolved;
  if (!newBaseName || /[\\/\0]/.test(newBaseName) || newBaseName === '..') {
    return { ok: false, status: 400, error: 'nombre de archivo inválido' };
  }
  if (!fs.existsSync(resolved.full) || !fs.statSync(resolved.full).isFile()) {
    return { ok: false, status: 404, error: 'Artefacto no encontrado' };
  }
  const dir = path.dirname(resolved.full);
  const destFull = path.resolve(path.join(dir, newBaseName));
  const rootWithSep = ARTIFACTS_ROOT.toLowerCase() + path.sep;
  if (!destFull.toLowerCase().startsWith(rootWithSep)) {
    return { ok: false, status: 400, error: 'destino fuera de docs/Artifacts' };
  }
  if (destFull.toLowerCase() === resolved.full.toLowerCase()) {
    return { ok: true, oldPath: resolved.rel, path: resolved.rel, full: resolved.full };
  }
  if (fs.existsSync(destFull)) {
    return { ok: false, status: 409, error: 'Ya existe un archivo con ese nombre' };
  }
  try {
    fs.renameSync(resolved.full, destFull);
  } catch (err) {
    return { ok: false, status: 500, error: `No se pudo renombrar: ${err.message}` };
  }
  const newRel = toPosixRel(ARTIFACTS_ROOT, destFull);
  return { ok: true, oldPath: resolved.rel, path: newRel, full: destFull };
}

/**
 * PATCH meta: actualiza display / categoría; opcionalmente renombra en disco.
 */
async function patchArtifactMeta(body = {}) {
  const rel = body.path;
  const resolved = resolveSafe(rel);
  if (!resolved.ok) return resolved;
  if (!fs.existsSync(resolved.full) || !fs.statSync(resolved.full).isFile()) {
    return { ok: false, status: 404, error: 'Artefacto no encontrado' };
  }

  const renameFile = !!body.renameFile;
  let workingPath = resolved.rel;
  let pathChanged = false;
  let oldPath = null;

  if (renameFile && body.displayName != null) {
    const ext = path.extname(resolved.full);
    const base = wikiStore.safeFileBaseName(body.displayName, ext);
    if (!base) {
      return { ok: false, status: 400, error: 'display_name no produce nombre de archivo válido' };
    }
    const renamed = renameArtifactFile(workingPath, base);
    if (!renamed.ok) return renamed;
    if (renamed.path !== workingPath) {
      pathChanged = true;
      oldPath = renamed.oldPath;
      workingPath = renamed.path;
      const moved = await wikiStore.moveMetaPath(
        oldPath,
        workingPath,
        body.displayName
      );
      if (!moved.ok) return moved;
    }
  }

  const patch = { path: workingPath };
  if (body.displayName !== undefined) patch.displayName = body.displayName;
  if (Object.prototype.hasOwnProperty.call(body, 'categoryId')) {
    patch.categoryId = body.categoryId;
  } else if (Object.prototype.hasOwnProperty.call(body, 'category_id')) {
    patch.categoryId = body.category_id;
  }

  const upserted = await wikiStore.upsertMeta(patch);
  if (!upserted.ok) return upserted;

  return {
    ok: true,
    meta: upserted.meta,
    pathChanged,
    oldPath,
    path: workingPath,
  };
}

module.exports = {
  ARTIFACTS_ROOT,
  ensureRoot,
  resolveSafe,
  scanArtifacts,
  scanArtifactsDisk,
  readArtifactMeta,
  renameArtifactFile,
  patchArtifactMeta,
  MIME,
  TEXT_EXTS,
};
