'use strict';

/**
 * «Tendencia actual»: antes del .ps1 se detecta el bias H1 del mercado con
 * `python -m app.controllers.detect_h1_bias` (mismas velas y criterio EMA20/50 que el
 * pipeline) y la corrida se fuerza con -Bullish / -Bearish. NEUTRAL o fallo → sin forzar.
 */
const { spawn } = require('node:child_process');

const MARKER = 'TREND_BIAS_JSON';
const DEFAULT_TIMEOUT_MS = 60_000;

const METHOD_LABELS = {
  h1_bias: 'EMA20/50 + precio + pendiente alineados',
  ema20_vs_ema50: 'desempate EMA20 vs EMA50',
  ema20_slope: 'desempate pendiente EMA20',
  sin_datos: 'sin datos suficientes',
};

/** Última línea `TREND_BIAS_JSON {...}` del stdout → objeto, o null. */
function parseTrendBiasOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter((l) => l.startsWith(`${MARKER} `));
  if (!lines.length) return null;
  try {
    return JSON.parse(lines.at(-1).slice(MARKER.length + 1));
  } catch {
    return null;
  }
}

function fmt(n) {
  return typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : 'n/d';
}

/**
 * Resultado del detector (o error) → flag a forzar + línea de log.
 * @param {object|null} result salida de detect_h1_bias
 * @param {string} [error] fallo de ejecución
 * @returns {{ flag: 'bullish'|'bearish'|null, bias: string, label: string, method: string|null, log: string }}
 */
function trendBiasDecision(result, error) {
  if (!result?.ok) {
    const why = error || result?.error || 'sin respuesta del detector';
    return {
      flag: null,
      bias: 'NEUTRAL',
      label: 'NEUTRAL',
      method: null,
      log: `[bias] No se pudo detectar la tendencia H1 (${why}) → sin forzar bias`,
    };
  }
  const flag = result.flag === 'bullish' || result.flag === 'bearish' ? result.flag : null;
  const label = result.label || result.bias || 'NEUTRAL';
  const detail = [
    METHOD_LABELS[result.method] || result.method,
    `close ${fmt(result.close)} · EMA20 ${fmt(result.ema20)} · EMA50 ${fmt(result.ema50)}`,
    result.source,
  ]
    .filter(Boolean)
    .join(' · ');
  const action = flag ? (flag === 'bullish' ? '-Bullish' : '-Bearish') : 'sin forzar bias';
  return {
    flag,
    bias: result.bias || 'NEUTRAL',
    label,
    method: result.method || null,
    log: `[bias] Tendencia actual H1: ${label} → ${action} (${detail})`,
  };
}

/**
 * Ejecuta el detector Python. Nunca rechaza: devuelve { result, error }.
 * @param {{ py: string, cwd: string, env: object, market: string, timeoutMs?: number }} opts
 */
function detectTrendBias({ py, cwd, env, market, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = parseTrendBiasOutput(stdout);
      resolve({ result, error: result ? undefined : error || stderr.trim().split(/\r?\n/).at(-1) });
    };
    const child = spawn(py, ['-m', 'app.controllers.detect_h1_bias', '--market', market], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(`timeout ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => finish(err.message));
    child.on('close', (code) => finish(code === 0 ? undefined : `exit ${code}`));
  });
}

module.exports = { MARKER, parseTrendBiasOutput, trendBiasDecision, detectTrendBias };
