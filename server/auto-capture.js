/**
 * Auto captura del resultado: spawnea app.views.trade_outcome_chart (Cursor Trading) con los
 * niveles del plan de la fila, devuelve el PNG + el resultado detectado con precio real.
 * Independiente del lock de corridas de señales y del canal SSE de jobs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const NO_LEVELS_ERROR = 'Sin niveles SL/Entrada/TP para esta señal';
const AUTO_CAPTURE_MARKETS = new Set(['btc', 'us30', 'xauusd']);
const TIMEOUT_MS = 120_000;
const RESULTADO_LABEL = { ganada: 'Ganada', perdida: 'Perdida' };
const FILE_BLOCKED_CODE = 'file_blocked';
const SCRIPT_ATTEMPTS = 2;
const READ_RETRIES = 4;
const READ_RETRY_MS = 250;
const MAX_ERROR_LEN = 300;
const ACCESS_DENIED_RE = /avgMonFltProxy|\[Errno 13\]|Permission denied|\[WinError (5|32)\]|EPERM|EACCES|EBUSY/i;

/** Niveles + hora/precio de la señal desde la fila del historial (getById). */
function resolveAutoCaptureInput(row) {
  if (!row) return { ok: false, error: 'Entrada no encontrada', code: 'not_found' };
  if (!AUTO_CAPTURE_MARKETS.has(row.market)) {
    return { ok: false, error: `Auto captura no disponible para ${row.market}`, code: 'market' };
  }
  const levels = [row.plannedEntry, row.plannedSl, row.plannedTp];
  if (!levels.every((v) => Number.isFinite(v) && v > 0)) {
    return { ok: false, error: NO_LEVELS_ERROR, code: 'no_levels' };
  }
  const signalTime = row.finishedAt || row.createdAt;
  if (!signalTime) return { ok: false, error: 'La señal no tiene hora registrada', code: 'no_time' };
  const price = Number(row.summary?.price);
  return {
    ok: true,
    input: {
      market: row.market,
      signalTime,
      entry: levels[0],
      sl: levels[1],
      tp: levels[2],
      price: Number.isFinite(price) && price > 0 ? price : null,
      real: realExecution(row.real),
    },
  };
}

/** Ejecución MT5 guardada (mt5-pnl) utilizable en el gráfico, o null → estimación con velas. */
function realExecution(real) {
  if (!real?.ticket || !(real.entry > 0) || !(real.exit > 0) || !real.closedAt) return null;
  return {
    ticket: real.ticket,
    entry: real.entry,
    exit: real.exit,
    sl: real.sl > 0 ? real.sl : null,
    openedAt: real.openedAt || null,
    closedAt: real.closedAt,
  };
}

function buildAutoCaptureArgs(input, outPath) {
  const args = [
    '-m', 'app.views.trade_outcome_chart',
    '--market', input.market,
    '--signal-time', String(input.signalTime),
    '--entry', String(input.entry),
    '--sl', String(input.sl),
    '--tp', String(input.tp),
    '--out', outPath,
  ];
  if (input.price != null) args.push('--price', String(input.price));
  const real = input.real;
  if (real) {
    args.push(
      '--real-entry', String(real.entry),
      '--real-exit', String(real.exit),
      '--real-close-time', String(real.closedAt),
      '--real-ticket', String(real.ticket),
    );
    if (real.openedAt) args.push('--real-open-time', String(real.openedAt));
    if (real.sl) args.push('--real-sl', String(real.sl));
  }
  return args;
}

/**
 * Compara el resultado detectado con el elegido por el usuario (nunca lo cambia).
 * @returns {{ detected: string|null, mismatch: boolean, warning: string|null }}
 */
function compareOutcome(outcome, resultado) {
  const detected = outcome?.detected || null;
  // Cierre real de MT5: manda sobre la estimación con velas (el signo ya lo valida mt5-pnl).
  if (outcome?.closeSource === 'mt5') return { detected, mismatch: false, warning: null };
  const chosen = RESULTADO_LABEL[resultado] ? resultado : null;
  if (detected && chosen && detected !== chosen) {
    return {
      detected,
      mismatch: true,
      warning: `El precio indica ${outcome.label} (${RESULTADO_LABEL[detected]}) pero marcaste ${RESULTADO_LABEL[chosen]}. Revisa el resultado.`,
    };
  }
  const warnings = {
    not_filled: outcome?.message,
    ambiguous: outcome?.message,
    open: outcome?.message,
  };
  return { detected, mismatch: false, warning: warnings[outcome?.outcome] || null };
}

/** Última línea JSON (objeto) de stdout del script Python. */
function parseScriptOutput(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
  try {
    const out = JSON.parse(line);
    if (out && typeof out === 'object' && !Array.isArray(out)) return out;
  } catch {
    /* cae al error genérico */
  }
  return { ok: false, error: 'salida inválida del script de auto captura' };
}

/** Mensaje en español cuando el antivirus bloquea archivos, con qué excluir exactamente. */
function fileBlockedMessage({ python, workDir, detail }) {
  const av = /avg/i.test(String(detail || '')) ? 'El antivirus (AVG)' : 'El antivirus';
  return `${av} bloqueó el acceso a un archivo al generar la captura. `
    + `Agrega una excepción para ${python} y la carpeta ${workDir}, o usa Adjuntar.`;
}

/**
 * Texto de error apto para la UI: sin volcados JSON/dict, sin llaves sueltas, una línea y corto.
 * @param {unknown} raw
 */
function rawErrorText(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') return raw.error || raw.message || '';
  return '';
}

/** `.error` de un volcado JSON completo, o null si el texto no lo es. */
function jsonDumpError(text) {
  if (!/^\{[\s\S]*\}$/.test(text)) return null;
  try {
    const inner = JSON.parse(text);
    return inner && typeof inner === 'object' && inner.error ? inner.error : null;
  } catch {
    return null;
  }
}

/** Quita llaves/corchetes de cierre o apertura que no tienen pareja (p. ej. un `}` final suelto). */
function stripUnbalancedBrackets(text) {
  const count = (s, re) => (s.match(re) || []).length;
  let t = text;
  while (/[}\]]$/.test(t) && count(t, /[}\]]/g) > count(t, /[{[]/g)) t = t.slice(0, -1).trimEnd();
  while (/^[{[]/.test(t) && count(t, /[{[]/g) > count(t, /[}\]]/g)) t = t.slice(1).trimStart();
  return t.replace(/,$/, '');
}

/**
 * Texto de error apto para la UI: sin volcados JSON/dict, sin llaves sueltas, una línea y corto.
 * @param {unknown} raw
 */
function cleanErrorMessage(raw) {
  const text = String(rawErrorText(raw) || '').trim();
  const inner = jsonDumpError(text);
  if (inner) return cleanErrorMessage(inner);
  const lastLine = text.split(/\r?\n/).findLast((l) => l.trim()) || '';
  const clean = stripUnbalancedBrackets(lastLine.replace(/\s+/g, ' ').trim());
  if (!clean) return 'No se pudo generar la captura';
  return clean.length > MAX_ERROR_LEN ? `${clean.slice(0, MAX_ERROR_LEN - 1)}…` : clean;
}

/** Error del script → { error, code? } listo para responder. */
function describeScriptError(out, { python, workDir }) {
  const detail = [out?.detail, out?.error].filter(Boolean).join(' ');
  if (out?.code === FILE_BLOCKED_CODE || ACCESS_DENIED_RE.test(detail)) {
    return { error: fileBlockedMessage({ python, workDir, detail }), code: FILE_BLOCKED_CODE };
  }
  return { error: cleanErrorMessage(out?.error || 'No se pudo generar la captura') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lee el PNG reintentando bloqueos breves (el antivirus escanea el archivo recién escrito). */
async function readFileWithRetry(file, { retries = READ_RETRIES, delayMs = READ_RETRY_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(file);
    } catch (err) {
      const transient = ['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
      if (!transient || attempt >= retries) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

/** Entorno del script: cachés y temporales dentro del proyecto, no en el perfil/temp del sistema. */
function buildScriptEnv(workDir, baseEnv = process.env) {
  const tmp = path.join(workDir, 'tmp');
  const mpl = path.join(workDir, 'mplconfig');
  for (const dir of [tmp, mpl]) fs.mkdirSync(dir, { recursive: true });
  return {
    ...baseEnv,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    MPLCONFIGDIR: mpl,
    MPLBACKEND: 'Agg',
    TEMP: tmp,
    TMP: tmp,
  };
}

/** Una ejecución del script → { ok, out, stderr } o { ok:false, spawnError }. */
function spawnScript({ py, args, cwd, env, spawnFn, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(py, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, spawnError: err });
      return;
    }
    child.stdin?.end();
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => done({ ok: false, spawnError: err, stderr }));
    child.on('close', () => done({ ok: true, out: parseScriptOutput(stdout), stderr }));
  });
}

/** Ruta del PNG a leer: la pedida, o la alternativa que haya escrito el script dentro de workDir. */
function resolveChartPath(out, outPath, workDir) {
  if (fs.existsSync(outPath) || typeof out?.chart !== 'string') return outPath;
  const chart = path.resolve(out.chart);
  const rel = path.relative(workDir, chart);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return inside && fs.existsSync(chart) ? chart : outPath;
}

/**
 * Ejecuta el script y devuelve { ok, outcome, buffer } o { ok:false, error, code? }.
 * Si el antivirus bloquea un archivo, reintenta el script una vez antes de rendirse.
 * @param {{ input: object, tradingRoot: string, workDir: string, python?: string, spawnFn?: Function,
 *   timeoutMs?: number, attempts?: number, retryDelayMs?: number }} opts
 */
async function runAutoCapture({
  input,
  tradingRoot,
  workDir,
  python,
  spawnFn = spawn,
  timeoutMs = TIMEOUT_MS,
  attempts = SCRIPT_ATTEMPTS,
  retryDelayMs = 1000,
}) {
  if (!workDir) throw new Error('runAutoCapture: workDir es obligatorio');
  const dir = path.resolve(workDir);
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const ctx = {
    input,
    tradingRoot,
    outDir,
    workDir: dir,
    py: python || process.env.PYTHON || process.env.PYTHON_EXE || 'python',
    env: buildScriptEnv(dir),
    spawnFn,
    timeoutMs,
  };
  let result;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(retryDelayMs);
    result = await runAttempt(ctx, attempt);
    if (result.ok || result.code !== FILE_BLOCKED_CODE) break;
  }
  return result;
}

/** Un intento: spawnea el script, lee el PNG y borra los temporales. */
async function runAttempt({ input, tradingRoot, outDir, workDir, py, env, spawnFn, timeoutMs }, attempt) {
  const outPath = path.join(outDir, `autocapture-${input.market}-${Date.now()}-${process.pid}-${attempt}.png`);
  const run = await spawnScript({
    py, args: buildAutoCaptureArgs(input, outPath), cwd: tradingRoot, env, spawnFn, timeoutMs,
  });
  let chartPath = outPath;
  try {
    if (!run.ok) {
      console.warn('[auto-capture] spawn:', run.spawnError?.message);
      return { ok: false, error: `No se pudo ejecutar Python (${py}): ${cleanErrorMessage(run.spawnError?.message)}` };
    }
    const { out, stderr } = run;
    if (!out.ok) {
      if (stderr.trim()) console.warn('[auto-capture] stderr:', stderr.trim().slice(-1500));
      return { ok: false, ...describeScriptError(out, { python: py, workDir }) };
    }
    chartPath = resolveChartPath(out, outPath, workDir);
    let buffer;
    try {
      buffer = await readFileWithRetry(chartPath);
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return { ok: false, error: 'El script no generó el PNG' };
      return { ok: false, error: fileBlockedMessage({ python: py, workDir, detail: err.message }), code: FILE_BLOCKED_CODE };
    }
    const outcome = { ...out };
    delete outcome.ok;
    delete outcome.chart;
    return { ok: true, outcome, buffer };
  } finally {
    safeUnlink(outPath);
    if (chartPath !== outPath) safeUnlink(chartPath);
  }
}

module.exports = {
  NO_LEVELS_ERROR,
  FILE_BLOCKED_CODE,
  resolveAutoCaptureInput,
  buildAutoCaptureArgs,
  compareOutcome,
  parseScriptOutput,
  cleanErrorMessage,
  describeScriptError,
  buildScriptEnv,
  readFileWithRetry,
  runAutoCapture,
};
