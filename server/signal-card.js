/**
 * Tarjeta de señal (póster) compuesta en el servidor.
 *
 * El navegador manda el modelo de la tarjeta (ShareCardModel, ya calculado en Angular) y la API
 * la dibuja con Python/Pillow (`app/views/signal_card.py` del motor), leyendo el PNG de entrada
 * directamente de live/. Así el APK recibe la misma imagen que el escritorio aunque el WebView
 * no consiga pintar el gráfico en su canvas. Sin node-canvas ni sharp (no están en Termux).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_TEXT = 400;
const MAX_ITEMS = 12;
const DEFAULT_TIMEOUT_MS = 60_000;

function text(v) {
  if (v == null) return '';
  return String(v).replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, MAX_TEXT);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function list(v) {
  return Array.isArray(v) ? v.slice(0, MAX_ITEMS) : [];
}

function scenario(v) {
  if (!v || typeof v !== 'object') return null;
  const bullets = list(v.bullets).map(text).filter(Boolean);
  if (!bullets.length) return null;
  return { title: text(v.title) || 'Escenario', tone: text(v.tone) === 'loss' ? 'loss' : 'gain', bullets };
}

/**
 * Modelo acotado para pasar a Python: solo claves conocidas, textos cortos, listas cortas.
 * No completa nada: lo que no venga, no se pinta.
 * @param {any} raw
 */
function sanitizeCardSpec(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const direction = text(c.direction);
  const odds = c.odds && typeof c.odds === 'object' ? { compra: num(c.odds.compra), venta: num(c.odds.venta) } : null;
  const action = c.action && typeof c.action === 'object' ? text(c.action.state) : '';
  return {
    symbol: text(c.symbol).toUpperCase(),
    timeframe: text(c.timeframe) || null,
    tier: text(c.tier) || null,
    price: text(c.price) || null,
    asOf: text(c.asOf) || null,
    direction: direction === 'Alcista' || direction === 'Bajista' ? direction : null,
    odds: odds && odds.compra != null && odds.venta != null ? odds : null,
    pills: list(c.pills)
      .filter((p) => p && typeof p === 'object' && text(p.title))
      .map((p) => ({ kicker: text(p.kicker), title: text(p.title), detail: text(p.detail) || null })),
    action: action === 'TOMAR' || action === 'ESPERAR' ? { state: action, reason: text(c.action.reason) || null } : null,
    levels: list(c.levels)
      .filter((l) => l && typeof l === 'object' && text(l.value))
      .map((l) => ({ label: text(l.label), value: text(l.value), tone: ['gain', 'loss'].includes(text(l.tone)) ? text(l.tone) : 'text' })),
    primary: scenario(c.primary),
    pullback: scenario(c.pullback),
    footer: text(c.footer) || null,
    risk: num(c.risk),
    riskFill: num(c.riskFill),
    riskNote: text(c.riskNote) || null,
  };
}

/** true si el modelo trae algo que pintar (no se compone una tarjeta vacía). */
function specHasContent(spec) {
  return !!(spec.symbol || spec.price || spec.pills.length || spec.levels.length || spec.primary || spec.pullback || spec.footer);
}

function cardsDir(env = process.env) {
  const data = env.HISTORY_DATA_DIR || path.join(__dirname, '..', 'data');
  return path.join(path.resolve(data), 'signal-cards');
}

function cardFileName(market) {
  return `${String(market).toLowerCase().replaceAll(/[^a-z0-9]/g, '')}_signal_card.png`;
}

/** Último PNG compuesto para el mercado, o null. */
function latestCardFile(market, env = process.env) {
  const full = path.join(cardsDir(env), cardFileName(market));
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size < 24) return null;
    return { full, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function cardUrl(market, mtimeMs) {
  return `/api/signals/card?market=${encodeURIComponent(market)}&v=${Math.round(mtimeMs)}`;
}

/** Última línea JSON de stdout del script; si no hay, error legible. */
function parseScriptOutput(stdout, stderr, code) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* sin JSON */
  }
  const err = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return { ok: false, error: err || `el compositor terminó con código ${code}` };
}

/**
 * Compone la tarjeta. Devuelve `{ ok, path, chart, chartError, error }`.
 * @param {{ py?: string, tradingRoot: string, spec: object, chartPath?: string|null, outPath: string,
 *   env?: NodeJS.ProcessEnv, spawnImpl?: typeof spawn, timeoutMs?: number }} opts
 */
async function composeSignalCard(opts) {
  const py = opts.py || process.env.PYTHON || process.env.PYTHON_EXE || 'python';
  const spawnImpl = opts.spawnImpl || spawn;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const spec = { ...sanitizeCardSpec(opts.spec), chart: opts.chartPath || null };
  if (!specHasContent(spec)) return { ok: false, error: 'La tarjeta no trae datos que pintar' };
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-card-'));
  const specPath = path.join(tmpDir, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
  try {
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child;
      try {
        child = spawnImpl(py, ['-m', 'app.views.signal_card', '--spec', specPath, '--out', opts.outPath], {
          cwd: opts.tradingRoot,
          env: { ...(opts.env || process.env), PYTHONIOENCODING: 'utf-8', MPLBACKEND: 'Agg' },
          windowsHide: true,
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ya terminó */ }
        resolve({ ok: false, error: 'el compositor tardó demasiado' });
      }, timeoutMs);
      child.stdout?.on('data', (d) => { stdout += d; });
      child.stderr?.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: `no se pudo ejecutar ${py}: ${err.message}` }); });
      child.on('close', (code) => { clearTimeout(timer); resolve(parseScriptOutput(stdout, stderr, code)); });
    });
    if (!result.ok) return { ok: false, error: result.error || 'error al componer la tarjeta' };
    if (!fs.existsSync(opts.outPath)) return { ok: false, error: 'el compositor no escribió el PNG' };
    return { ok: true, path: opts.outPath, chart: !!result.chart, chartError: result.chart_error || null };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = {
  MAX_TEXT,
  MAX_ITEMS,
  sanitizeCardSpec,
  specHasContent,
  cardsDir,
  cardFileName,
  latestCardFile,
  cardUrl,
  parseScriptOutput,
  composeSignalCard,
};
