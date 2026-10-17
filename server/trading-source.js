/**
 * Origen del motor Cursor Trading.
 * Por defecto se descarga el árbol completo desde el endpoint de GitHub
 * (flash-trading-signals). La carpeta local D:\Danilo\Trading\Cursor Trading
 * ya no es el default. CURSOR_TRADING_ROOT sigue ganando si apunta a otra ruta
 * que exista (Android, tests). CURSOR_TRADING_LOCAL=1 fuerza también la ruta vieja.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const LEGACY_TRADING_ROOT = path.normalize(String.raw`D:\Danilo\Trading\Cursor Trading`);
const DEFAULT_REF = 'main';
const DEFAULT_ENDPOINT =
  'https://github.com/minichaverra-beep/flash-trading-signals/archive/refs/heads/main.tar.gz';
const DEFAULT_COMMIT_URL =
  'https://api.github.com/repos/minichaverra-beep/flash-trading-signals/commits/main';
const STAMP = '.source-sha';
const HEADERS = {
  'User-Agent': 'flash-signals-angular',
  Accept: 'application/vnd.github+json',
};

function endpointOf(env) {
  return String(env.CURSOR_TRADING_ENDPOINT || DEFAULT_ENDPOINT).trim();
}

function commitUrlOf(env) {
  return String(env.CURSOR_TRADING_COMMIT_URL || DEFAULT_COMMIT_URL).trim();
}

function cacheDirOf(env) {
  if (env.CURSOR_TRADING_CACHE) return path.resolve(env.CURSOR_TRADING_CACHE);
  const data = env.HISTORY_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(path.resolve(data), 'cursor-trading');
}

/** Ruta explícita, o null si no hay o si es el default local viejo. */
function explicitRoot(env) {
  const raw = String(env.CURSOR_TRADING_ROOT || '').trim();
  if (!raw) return null;
  const norm = path.normalize(raw);
  const legacy = path.normalize(LEGACY_TRADING_ROOT);
  if (env.CURSOR_TRADING_LOCAL !== '1' && norm.toLowerCase() === legacy.toLowerCase()) return null;
  return path.resolve(norm);
}

function engineReady(root) {
  return !!(root && fs.existsSync(path.join(root, 'scripts', 'analyze', 'analyze.sh')));
}

function readStamp(root) {
  try {
    return fs.readFileSync(path.join(root, STAMP), 'utf8').trim();
  } catch {
    return '';
  }
}

function writeStamp(root, sha) {
  fs.writeFileSync(path.join(root, STAMP), `${sha}\n`, 'utf8');
}

async function remoteSha(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`commit endpoint ${res.status}`);
  const body = await res.json();
  const sha = body && body.sha;
  if (!sha) throw new Error('commit endpoint sin sha');
  return String(sha);
}

async function downloadFile(url, dest, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': HEADERS['User-Agent'] },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`endpoint ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `tar salió ${code}`));
    });
  });
}

async function extractTarball(tarPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  await runTar(['-xzf', tarPath, '-C', destDir]);
  const dirs = fs.readdirSync(destDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (dirs.length !== 1) throw new Error('el tarball no trae una sola carpeta raíz');
  return path.join(destDir, dirs[0].name);
}

/** Copia el árbol nuevo encima de la caché. Si ya hay live/, no lo pisa. */
function installTree(extractedRoot, cache) {
  fs.mkdirSync(cache, { recursive: true });
  const keepLive = fs.existsSync(path.join(cache, 'live'));
  fs.cpSync(extractedRoot, cache, {
    recursive: true,
    force: true,
    filter(src) {
      if (!keepLive) return true;
      const rel = path.relative(extractedRoot, src);
      if (!rel || rel === '.') return true;
      return rel.split(path.sep)[0] !== 'live';
    },
  });
}

/**
 * @returns {Promise<{ root: string, source: string, endpoint: string|null, sha: string|null, error: string|null }>}
 */
async function ensureTradingRoot(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const download = options.download || downloadFile;
  const extract = options.extract || extractTarball;
  const explicit = explicitRoot(env);
  if (explicit && engineReady(explicit)) {
    return { root: explicit, source: 'local', endpoint: null, sha: null, error: null };
  }

  const endpoint = endpointOf(env);
  const cache = cacheDirOf(env);
  const fallback = env.CURSOR_TRADING_FALLBACK ? path.resolve(env.CURSOR_TRADING_FALLBACK) : '';
  let sha = null;
  try {
    sha = await remoteSha(commitUrlOf(env), fetchImpl, Number(env.CURSOR_TRADING_SHA_TIMEOUT_MS || 15000));
  } catch (err) {
    sha = null;
    if (engineReady(cache) && readStamp(cache)) {
      return {
        root: cache,
        source: 'cache',
        endpoint,
        sha: readStamp(cache),
        error: err.message,
      };
    }
  }

  if (sha && engineReady(cache) && readStamp(cache) === sha) {
    return { root: cache, source: 'endpoint', endpoint, sha, error: null };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-trading-'));
  const tarPath = path.join(tmp, 'engine.tar.gz');
  try {
    await download(endpoint, tarPath, fetchImpl, Number(env.CURSOR_TRADING_DOWNLOAD_TIMEOUT_MS || 180000));
    const extracted = await extract(tarPath, path.join(tmp, 'extract'));
    installTree(extracted, cache);
    writeStamp(cache, sha || 'unknown');
    return { root: cache, source: 'endpoint', endpoint, sha: sha || null, error: null };
  } catch (err) {
    if (engineReady(cache)) {
      return { root: cache, source: 'cache', endpoint, sha: readStamp(cache) || null, error: err.message };
    }
    if (fallback && engineReady(fallback)) {
      return { root: fallback, source: 'fallback', endpoint, sha: null, error: err.message };
    }
    return { root: cache, source: 'missing', endpoint, sha: null, error: err.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  LEGACY_TRADING_ROOT,
  DEFAULT_ENDPOINT,
  DEFAULT_REF,
  explicitRoot,
  cacheDirOf,
  ensureTradingRoot,
  installTree,
  engineReady,
};
