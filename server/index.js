/**
 * API local — orquesta scripts de Cursor Trading (PowerShell).
 * No genera señales fake: solo spawnea el pipeline real.
 */
const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const historyStore = require('./db/history-store');
const wikiStore = require('./db/wiki-store');
const macdQuantStore = require('./db/macd-quant-store');
const artifacts = require('./artifacts');
const mt5 = require('./mt5');
const mt5Settings = require('./mt5-settings');
const mt5Sent = require('./mt5-sent');
const mt5Pnl = require('./mt5-pnl');
const { JOB_EVENTS, createJobEvents } = require('./job-events');
const autoCapture = require('./auto-capture');
const trendBias = require('./trend-bias');
const vixSource = require('./vix-source');
const { resolveVolatilityAdjustment } = require('./volatility');
const { registerVolatilityRoutes } = require('./volatility-routes');
const {
  pickLatestChart,
  isChartStale,
  parseDataFreshness,
} = require('./live-freshness');

const PORT = Number(process.env.PORT || 3847);
/** Solo loopback: API local, no exponer a la LAN. */
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const TRADING_ROOT =
  process.env.CURSOR_TRADING_ROOT ||
  path.normalize(String.raw`D:\Danilo\Trading\Cursor Trading`);

/** Contraseña para borrar filas / limpiar historial (modo lock). Local desk tool. */
const HISTORY_UNLOCK_PASSWORD =
  process.env.HISTORY_UNLOCK_PASSWORD || 'Elxokas2026*'; // NOSONAR S2068 — solo loopback local

const ALLOWED_ORIGINS = new Set([
  'http://localhost:4400',
  'http://127.0.0.1:4400',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost',
  'http://127.0.0.1',
]);

/** Orígenes extra (CSV) p.ej. CORS_ORIGINS=http://localhost:8080,http://127.0.0.1:8080 */
for (const origin of String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)) {
  ALLOWED_ORIGINS.add(origin);
}

/** En Linux (Docker) no hay powershell.exe fiable para el pipeline Windows. */
const SIGNALS_RUNNABLE = process.platform === 'win32';
const MARKETS = new Set(['btc', 'us30', 'xauusd', 'ukoil']);
/** Mercados con pipeline E1 (analyze-*.ps1). ukoil = solo MACD-quant por ahora. */
const SIGNAL_MARKETS = new Set(['btc', 'us30', 'xauusd']);
const TIERS = new Set(['context', 'light', 'high', 'history']);
const MARKET_ERROR = 'market debe ser btc|us30|xauusd|ukoil';

/** Entry solo numérico (evita inyección vía args de PowerShell). */
function sanitizeEntry(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  return s;
}

function normalizeMarket(value) {
  const m = String(value || 'btc').toLowerCase();
  return MARKETS.has(m) ? m : null;
}

function normalizeTier(value) {
  const t = String(value || 'high').toLowerCase();
  return TIERS.has(t) ? t : null;
}

const REPORTS = {
  btc: {
    context: 'btc_m5_context.md',
    light: 'btc_m5_signal.md',
    high: 'btc_m5_high_signal.md',
    history: 'btc_m5_high_signal.md',
    chart: 'btc_m5_chart_annotated.png',
  },
  us30: {
    context: 'us30_m5_context.md',
    light: 'us30_m5_signal.md',
    high: 'us30_m5_high_signal.md',
    history: 'us30_m5_high_signal.md',
    chart: 'us30_m5_chart_annotated.png',
  },
  xauusd: {
    context: 'xauusd_m5_context.md',
    light: 'xauusd_m5_signal.md',
    high: 'xauusd_m5_high_signal.md',
    history: 'xauusd_m5_high_signal.md',
    // -Ilustrate → annotated; sin -NoChart → crudo con overlays. Se sirve el más reciente.
    chart: ['xauusd_m5_chart_annotated.png', 'xauusd_m5_chart.png'],
  },
  // UKOIL: sin pipeline E1; chart MACD-quant H4 (proxy Yahoo BZ=F).
  ukoil: {
    context: 'ukoil_m5_context.md',
    light: 'ukoil_m5_signal.md',
    high: 'ukoil_m5_high_signal.md',
    history: 'ukoil_m5_high_signal.md',
    chart: 'ukoil_h4_macd_quant.png',
  },
};

/** Clave YAML Zentinel por market (sección en config/zentinel_presets.yaml). */
function zentinelYamlKey(market) {
  if (market === 'us30') return 'US30';
  if (market === 'xauusd') return 'XAUUSD';
  if (market === 'ukoil') return 'UKOIL';
  return 'BTC';
}

/** @type {{ status: string, startedAt?: string, finishedAt?: string, market?: string, tier?: string, command?: string, exitCode?: number|null, logs: string[], error?: string|null, reportPath?: string|null, summary?: object|null, flags?: object, entry?: string|null, historyId?: number|null }} */
let currentJob = {
  status: 'idle',
  logs: [],
  exitCode: null,
  error: null,
  reportPath: null,
  summary: null,
  flags: null,
  entry: null,
  historyId: null,
  mt5: null,
};

const jobEvents = createJobEvents();
/** Jobs cuyo fin ya se emitió (error + close pueden llegar ambos). */
const announcedJobs = new WeakSet();

/** Snapshot serializable del job (sin flags internos de persistencia). */
function publicJob(job) {
  const snapshot = { ...job };
  delete snapshot.historyPersisted;
  delete snapshot.macdQuantPersisted;
  return snapshot;
}

/** Añade líneas al log del job y las emite como job:progress. */
function appendJobLogs(job, chunk, stream) {
  const lines = [];
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = `[${stream}] ${line}`;
    job.logs.push(entry);
    lines.push(entry);
  }
  if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  if (lines.length) {
    jobEvents.broadcast(JOB_EVENTS.progress, { id: job.id, lines });
  }
}

/** Emite job:finished / job:failed una sola vez por job. */
function announceJobEnd(job) {
  if (announcedJobs.has(job)) return;
  announcedJobs.add(job);
  const event = job.status === 'done' ? JOB_EVENTS.finished : JOB_EVENTS.failed;
  jobEvents.broadcast(event, publicJob(job));
}

/** Valida id numérico entero positivo (path param). */
function parseHistoryId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || String(raw).trim() !== String(n)) {
    return null;
  }
  return n;
}

/** Fila con candado (manual o de un día anterior): cualquier cambio salvo el candado responde 423. */
function sendHistoryLocked(res) {
  return res.status(423).json({ error: 'La fila está bloqueada', code: 'locked' });
}

/**
 * Modo lock: borrado de historial requiere contraseña
 * (header X-History-Unlock o body.password / unlockPassword).
 * @returns {boolean} true si autorizado; si no, ya respondió 401/403.
 */
function requireHistoryUnlock(req, res) {
  const fromHeader = req.get('x-history-unlock');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const provided = String(
    fromHeader ?? body.unlockPassword ?? body.password ?? ''
  );
  if (!provided) {
    res.status(401).json({
      error: 'Historial bloqueado: se requiere contraseña para borrar',
      locked: true,
    });
    return false;
  }
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(HISTORY_UNLOCK_PASSWORD, 'utf8');
  const ok =
    a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    res.status(403).json({
      error: 'Contraseña incorrecta',
      locked: true,
    });
    return false;
  }
  return true;
}

function flagsFromBody(body) {
  return {
    bullish: !!body.bullish,
    bearish: !!body.bearish,
    trendBias: !!body.trendBias,
    breakSetup: !!body.breakSetup,
    reverse: !!body.reverse,
    ml: !!body.ml,
    neural: !!body.neural,
    ilustrate: !!body.ilustrate,
    advanced: !!body.advanced,
    noChart: body.noChart !== false,
    noOpen: body.noOpen !== false,
  };
}

async function persistJobSnapshot(job, extras = {}) {
  if (job.historyPersisted) return;
  job.historyPersisted = true;
  try {
    const latest =
      job.status === 'done' && job.market
        ? readLatest(job.market, job.tier)
        : null;
    const result = await historyStore.insertSnapshot({
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      market: job.market,
      tier: job.tier,
      status: job.status,
      flags: job.flags || {},
      entry: job.entry ?? null,
      verdict: job.summary?.verdict || latest?.summary?.verdict || null,
      summary: job.summary || latest?.summary || null,
      reportPath: job.reportPath || latest?.reportPath || null,
      chartPath: latest?.chartPath || null,
      preview: latest?.preview || null,
      command: job.command || null,
      exitCode: job.exitCode,
      error: job.error || null,
      ...extras,
    });
    job.historyId = result.id;
    job.logs.push(`[history] Guardado en hive box id=${result.id}`);
  } catch (err) {
    job.logs.push(`[history] No se pudo guardar: ${err.message}`);
    console.error('[history] persist error:', err);
  }
}

/** Run operation del historial: solo la última señal y dentro de esta ventana desde que terminó. */
const MT5_RUN_WINDOW_MIN = 30;

/** Última corrida del historial ejecutable desde Run operation → { id, at, expiresAt, open }. */
async function runnableHistory() {
  const res = await historyStore.listHistory({ page: 1, pageSize: 1, sortBy: 'createdAt', sortDir: 'desc' });
  const last = res?.items?.[0];
  if (!last) return null;
  const at = last.finishedAt || last.createdAt;
  const expiresAt = new Date(new Date(at).getTime() + MT5_RUN_WINDOW_MIN * 60_000).toISOString();
  return { id: last.id, at, expiresAt, open: Date.now() <= Date.parse(expiresAt), windowMinutes: MT5_RUN_WINDOW_MIN };
}

/** Envíos en curso (perfil:clave): evita doble ejecución por clics/peticiones simultáneas. */
const mt5InFlight = new Set();

function volumeNoteSuffix(result) {
  return result?.volumeNote ? ` · ⚠ ${result.volumeNote}` : '';
}

/** Ajuste de SL/TP por VIX para un envío: multiplicador del nivel actual o ×1 con aviso si no hay dato. */
async function readVolatility(settings) {
  try {
    return resolveVolatilityAdjustment(settings, await vixSource.getVix(settings));
  } catch (err) {
    return resolveVolatilityAdjustment(settings, { error: err.attempts?.join(' · ') || err.message });
  }
}

function volatilitySuffix(volatility) {
  if (!volatility) return '';
  const warn = volatility.level ? '' : '⚠ ';
  return ` · ${warn}${volatility.note}`;
}

/**
 * Envía el plan Entry/SL/TP de una señal al puente MT5.
 * @returns {Promise<{ status: 'sent'|'skipped'|'error', message: string, result?: object, order?: object }>}
 */
async function pushSignalToMt5({ key, market, summary, overrides = {}, anyVerdict = false }) {
  const profileId = mt5Settings.getActive();
  const settings = mt5Settings.get(profileId);
  const profile = { id: profileId, label: mt5Settings.PROFILE_LABELS[profileId] };
  let built = mt5.buildOrderFromSummary(market, summary, settings, { anyVerdict });
  if (!built.order) return { status: 'skipped', message: built.skip, profile };
  // Con el toggle apagado no se pide el VIX; si falla la lectura la orden sigue con ×1 y un aviso.
  if (settings.volatilityAdjustEnabled) {
    const volatility = await readVolatility(settings);
    built = mt5.buildOrderFromSummary(market, summary, settings, { anyVerdict, volatility });
  }
  const { order, volatility } = built;
  // Por perfil (persistido): la misma señal puede ir a la cuenta principal y a la secundaria.
  const allowMultiple = overrides.allow_multiple || settings.allowMultiple;
  if (key && mt5Sent.has(profileId, key) && !allowMultiple) {
    return { status: 'skipped', message: `Esta señal ya se envió a MT5 con ${profile.label}`, order, profile };
  }
  const lockKey = key && !overrides.dry_run ? `${profileId}:${key}` : null;
  if (lockKey && mt5InFlight.has(lockKey)) {
    return { status: 'skipped', message: 'Esta señal ya se está enviando a MT5', order, profile };
  }
  if (lockKey) mt5InFlight.add(lockKey);
  try {
    const result = await mt5.pushOrder(order, { clientId: key, ...overrides }, settings);
    if (lockKey) mt5Sent.record(profileId, key, result);
    if (volatility) {
      result.volatilityNote = volatility.note;
      result.volatility = volatility;
    }
    const how = result.mode === 'market' ? 'mercado' : 'LIMIT';
    return {
      status: 'sent',
      message: `${order.side} ${result.symbol} ${result.volume} lotes · ${how} @ ${result.price} · SL ${result.sl} · TP ${result.tp} · ${profile.label}${result.dryRun ? ' (dry-run)' : ''}${volumeNoteSuffix(result)}${volatilitySuffix(volatility)}`,
      order,
      result,
      profile,
      volatility,
    };
  } catch (err) {
    return { status: 'error', message: err.message, order, profile, volatility, httpStatus: err.status, details: err.details };
  } finally {
    if (lockKey) mt5InFlight.delete(lockKey);
  }
}

const app = express();
app.disable('x-powered-by');
app.use(
  cors({
    origin(origin, callback) {
      // Sin Origin (curl / same-machine) o Angular local
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  })
);
// 8mb: permite adjuntar captura del resultado en base64 (~5 MB binario).
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Wiki embebe HTML/PDF en iframe same-origin vía /api/artifacts/raw (proxy :4400→:3847).
  // DENY aquí rompe el preview (icono roto / área gris) aunque "Abrir raw" funcione.
  if (!req.path.startsWith('/api/artifacts/raw')) {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  next();
});

function livePath(...parts) {
  return path.join(TRADING_ROOT, 'live', ...parts);
}

function scriptFor(market, tier) {
  const m = MARKETS.has(market) ? market : 'btc';
  const map = {
    context: `analyze-${m}-context.ps1`,
    light: `analyze-${m}-light.ps1`,
    high: `analyze-${m}-high.ps1`,
    history: `analyze-${m}-history.ps1`,
  };
  const name = map[tier];
  if (!name) return null;
  return path.join(TRADING_ROOT, 'scripts', 'analyze', name);
}

function buildPsArgs(body) {
  const tier = body.tier || 'high';
  const args = [];

  // Context: sin params
  if (tier === 'context') {
    return args;
  }

  // Light: solo ML / Neural / Bullish / Bearish
  if (tier === 'light') {
    if (body.ml) args.push('-ML');
    if (body.neural) args.push('-Neural');
    if (body.bullish) args.push('-Bullish');
    if (body.bearish) args.push('-Bearish');
    return args;
  }

  // High + History
  if (body.noChart !== false) args.push('-NoChart');
  if (body.bullish) args.push('-Bullish');
  if (body.bearish) args.push('-Bearish');
  if (body.breakSetup) args.push('-Break');
  if (body.reverse) args.push('-Reverse');
  if (body.ml) args.push('-ML');
  if (body.neural) args.push('-Neural');
  if (body.ilustrate) args.push('-Ilustrate');
  if (body.advanced) args.push('-Advanced');
  if (body.noOpen !== false) args.push('-NoOpen');

  // Entry solo en High (history no lo cablea); ya sanitizado en el handler
  if (tier === 'high' && body.entry) {
    args.push('-Entry', String(body.entry));
  }

  return args;
}

function stripMd(s) {
  return String(s || '')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .replaceAll('\u00a0', ' ')
    .trim();
}

function extractField(md, label) {
  const re = new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|]+)\\|`, 'i');
  const m = md.match(re);
  return m ? stripMd(m[1]) : null;
}

function parsePct(text) {
  if (text == null) return null;
  const m = String(text).match(/(-?\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  return Number(m[1].replace(',', '.'));
}

function parseNum(text) {
  if (text == null) return null;
  const m = String(text).match(/(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  return Number(m[1].replace(',', '.'));
}

function okFromCell(cell) {
  const t = stripMd(cell).toLowerCase();
  if (!t) return null;
  if (/^(sí|si|ok|true|yes|✓|✔|✅)/i.test(t) || t.includes('✓') || t.includes('✔')) {
    return true;
  }
  if (/^(no|false|✗|✘|❌|x\b)/i.test(t) || t.includes('✗') || t.includes('✘')) {
    return false;
  }
  // checkbox markdown / mojibake leftovers
  if (/\[\s*[x✓✔✅]\s*\]/i.test(cell)) return true;
  if (/\[\s*[ ]\s*\]/.test(cell) || /\[\s*[✗✘❌?]\s*\]/i.test(cell)) return false;
  return null;
}

function parseMarkdownTable(block) {
  const rows = [];
  for (const line of String(block || '').split(/\r?\n/)) {
    if (!/\|/.test(line)) continue;
    if (/^\s*\|?\s*-+/.test(line)) continue;
    const cells = line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => stripMd(c));
    if (cells.length >= 2) rows.push(cells);
  }
  return rows;
}

function parseChecklistSection(md, headingRe) {
  const block = md.match(headingRe);
  if (!block) return [];
  const items = [];
  for (const line of block[1].split(/\r?\n/)) {
    if (/^\s*\*\*/.test(line) || /^\s*_/.test(line)) continue;
    const checked = line.match(/^\s*[-*]\s+\[([^\]]*)\]\s*(.+)$/);
    const plain = !checked && line.match(/^\s*[-*]\s+(.+)$/);
    if (!checked && !plain) continue;
    let ok = null;
    let label = '';
    if (checked) {
      const mark = checked[1].trim();
      if (/[x✓✔✅]/.test(mark)) ok = true;
      else if (mark === '' || /[✗✘❌?\s]/.test(mark) || mark.toLowerCase() === ' ') ok = false;
      label = stripMd(checked[2]);
    } else {
      label = stripMd(plain[1]);
      if (/^[✓✔✅]/.test(label)) {
        ok = true;
        label = stripMd(label.replace(/^[✓✔✅]\s*/, ''));
      } else if (/^[✗✘❌]/.test(label)) {
        ok = false;
        label = stripMd(label.replace(/^[✗✘❌]\s*/, ''));
      }
    }
    if (label && !label.startsWith('#') && !/^falta\b/i.test(label)) {
      items.push({ label, ok, note: '' });
    }
  }
  return items.slice(0, 12);
}

function parseRulesTable(md, headingRe) {
  const block = md.match(headingRe);
  if (!block) return [];
  const rows = parseMarkdownTable(block[1]);
  // skip header
  return rows.slice(1).map((cells) => ({
    label: cells[0] || '',
    ok: okFromCell(cells[1] || ''),
    note: cells[2] || cells.slice(2).join(' · ') || '',
  })).filter((r) => r.label && !/^regla$/i.test(r.label) && !/^check$/i.test(r.label));
}

const RULE_GRADES = ['✓✓', '✓', '~', '✗✗', '✗', '·'];

/** Tabla «Reglas revisadas (graduadas)»: Regla | Estado | Valor | Impacto | Acierto | Tipo. */
function parseRulesReview(md) {
  const block = /###\s*Reglas revisadas[^\n]*\n([\s\S]*?)(?:\n###|\n##\s|\n---|$)/i.exec(String(md || ''));
  if (!block) return [];
  return parseMarkdownTable(block[1])
    .slice(1)
    .filter((cells) => cells[0] && !/^regla$/i.test(cells[0]))
    .map((cells) => {
      const raw = String(cells[1] || '').trim();
      return {
        label: cells[0],
        grade: RULE_GRADES.find((g) => raw.startsWith(g)) || raw || '·',
        value: cells[2] || '',
        impact: cells[3] || '',
        winrate: cells[4] || '',
        type: cells[5] || '',
      };
    });
}

function parsePlanDetails(md) {
  const planLine = extractField(md, 'Plan') || '';
  const entryFromPlan = (planLine.match(/Entry\s+\*?\*?([0-9.]+)/i) || [])[1];
  const slFromPlan = (planLine.match(/SL\s+\*?\*?([0-9.]+)/i) || [])[1];
  const tpFromPlan = (planLine.match(/TP\s+\*?\*?([0-9.]+)/i) || [])[1];

  const concreto = md.match(/###\s*Plan concreto\s*\n([\s\S]*?)(?:\n---|\n##\s|$)/i);
  const fields = {};
  if (concreto) {
    for (const row of parseMarkdownTable(concreto[1]).slice(1)) {
      if (row[0]) fields[row[0].toLowerCase()] = row[1] || '';
    }
  }

  const pick = (...keys) => {
    for (const k of keys) {
      for (const [fk, fv] of Object.entries(fields)) {
        if (fk.includes(k) && fv) return fv;
      }
    }
    return null;
  };

  const firstNum = (s) => {
    if (!s) return null;
    const m = String(s).match(/(\d+(?:\.\d+)?)/);
    return m ? m[1] : stripMd(String(s).split(/[·•|]/)[0]);
  };

  const entry =
    pick('entry usuario', 'entry') ||
    extractField(md, 'Entry') ||
    entryFromPlan ||
    null;
  const sl = pick('sl') || slFromPlan || null;
  const tp = pick('tp') || tpFromPlan || null;
  const rr =
    pick('r:r') ||
    extractField(md, 'R:R') ||
    (planLine.match(/R:R\s+\*?\*?([0-9:]+)/i) || [])[1] ||
    null;
  const risk =
    pick('riesgo') ||
    extractField(md, 'Riesgo (pts)') ||
    (String(pick('r:r') || '').match(/riesgo\s+\*?\*?([0-9.]+)/i) || [])[1] ||
    null;

  return {
    entry: firstNum(entry),
    sl: firstNum(sl),
    tp: firstNum(tp),
    rr: rr ? stripMd(String(rr).split(/[·•]/)[0]) : null,
    risk: risk ? firstNum(risk) : null,
    trigger: pick('trigger'),
    invalidation: pick('invalidaci'),
    confirmation: pick('confirmaci'),
  };
}

function parseScorecard(md) {
  const block = md.match(
    /##\s*B\)\s*Scorecard multicapa\s*\n([\s\S]*?)(?:\n---|\n##\s)/i
  );
  if (!block) return [];
  const rows = parseMarkdownTable(block[1]).slice(1);
  return rows
    .map((cells) => {
      const labelRaw = stripMd(cells[0] || '').replace(/^\*\*|\*\*$/g, '');
      const label = /score\s*combinado|^combinado$/i.test(labelRaw)
        ? 'Probabilidad de éxito'
        : labelRaw;
      const raw = stripMd(cells[1] || '');
      const weight = stripMd(cells[2] || '');
      const note = stripMd(cells[3] || '');
      let value = parsePct(raw);
      if (value == null) {
        const frac = raw.match(/(\d+)\s*\/\s*(\d+)/);
        if (frac) value = Math.round((Number(frac[1]) / Number(frac[2])) * 1000) / 10;
      }
      // CRT "fail" → 0%. Neural "n/d" / omitido must stay null (was wrongly shown as 0% bar).
      if (value == null && /^fail$/i.test(raw.trim())) value = 0;
      return { label, value, raw, weight, note };
    })
    .filter((r) => r.label && !/^capa$/i.test(r.label))
    .slice(0, 12);
}

function parseMetricsLine(md) {
  const metrics = extractField(md, 'Métricas') || extractField(md, 'Metricas') || '';
  const rulesPct = parsePct((metrics.match(/Rules\s+\*?\*?([^|]+?)(?:·|•|\||$)/i) || [])[1] || metrics);
  const mlPct = parsePct((metrics.match(/ML\s+\*?\*?([^|]+?)(?:·|•|\||$)/i) || [])[1] || '');
  const confM =
    metrics.match(/Confluencia\s+\*?\*?([A-ZÁÉÍÓÚ]+)\*?\*?\s*[-–—]?\s*(\d+(?:[.,]\d+)?)\s*%/i) ||
    metrics.match(/Confluencia\s+\*?\*?(\d+(?:[.,]\d+)?)\s*%/i);
  let confluenceLabel = null;
  let confluencePct = null;
  if (confM) {
    if (confM[2]) {
      confluenceLabel = stripMd(confM[1]);
      confluencePct = Number(String(confM[2]).replace(',', '.'));
    } else if (/^\d/.test(confM[1])) {
      confluencePct = Number(String(confM[1]).replace(',', '.'));
    } else {
      confluenceLabel = stripMd(confM[1]);
      confluencePct = parsePct(metrics.slice(metrics.toLowerCase().indexOf('confluencia')));
    }
  }
  // fallbacks from other fields
  const rulesFromField = parsePct(extractField(md, 'Rules E1 detalle') || '');
  const scoreExt = parsePct(extractField(md, 'Score Rules extendido') || '');
  const combined =
    parsePct((md.match(/score combinado\s+\*?\*?(\d+(?:[.,]\d+)?)\s*%/i) || [])[0] || '') ||
    parsePct((md.match(/\*\*Score combinado\*\*\s*\|\s*\*\*(\d+(?:[.,]\d+)?)\s*%/i) || [])[0] || '');

  return {
    rulesPct: rulesPct ?? rulesFromField,
    mlPct,
    confluencePct,
    confluenceLabel,
    scoreExtended: scoreExt,
    scoreCombined: combined,
  };
}

function parseVolumeZentinel(md) {
  const volLine =
    extractField(md, 'Vol Zentinel \\(filtro\\)') ||
    extractField(md, 'Vol Zentinel (filtro)') ||
    (() => {
      const m = md.match(/\|\s*Vol Zentinel[^\|]*\|\s*([^|]+)\|/i);
      return m ? stripMd(m[1]) : null;
    })();
  if (!volLine) return { band: null, ratio: null, preset: null };
  // e.g. muy_bajo · 0.00× · Zentinel_US30_E1
  const parts = volLine.split(/[·•|]/).map((p) => stripMd(p)).filter(Boolean);
  const band = parts[0] || null;
  let ratio = null;
  for (const p of parts) {
    const m = p.match(/(\d+(?:[.,]\d+)?)\s*[x×]/i);
    if (m) {
      ratio = Number(m[1].replace(',', '.'));
      break;
    }
  }
  const preset = parts.find((p) => /zentinel/i.test(p)) || parts.at(-1) || null;
  return { band, ratio, preset };
}

function readVolumeThresholds(market) {
  const yamlPath = path.join(TRADING_ROOT, 'config', 'zentinel_presets.yaml');
  if (!fs.existsSync(yamlPath)) return null;
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const key = zentinelYamlKey(market);
  const sec = raw.match(new RegExp(`\\n\\s*${key}:([\\s\\S]*?)(?:\\n\\s{2}[A-Z]{2,}|$)`));
  const chunk = sec ? sec[1] : raw;
  const fvg = chunk.match(/fvg_volume:([\s\S]*?)(?:\n\s{4}\w|\n\s{2}\w|$)/);
  const block = fvg ? fvg[1] : chunk;
  const num = (k) => {
    const m = block.match(new RegExp(`${k}:\\s*([0-9.]+)`, 'i'));
    return m ? Number(m[1]) : null;
  };
  return {
    high: num('high'),
    extreme: num('extreme'),
    low: num('low'),
    very_low: num('very_low'),
    period: num('period'),
    presetName: ((block.match(/preset_name:\s*(\S+)/) || [])[1] || null),
  };
}

function parseSummary(md, market, tier) {
  if (!md) return null;

  const verdictMatch =
    md.match(/##\s*Veredicto:\s*(.+)/i) ||
    md.match(/\|\s*Veredicto\s*\|\s*\*\*(.+?)\*\*/i);
  const plan = extractField(md, 'Plan');
  const twoM5 =
    extractField(md, 'Estado 2M5') ||
    (md.match(/Estado 2M5[^\n]*\n[^\n]*\|\s*([^|]+)\|/i) || [])[1];
  const killzone =
    extractField(md, 'Killzone / sesión') ||
    extractField(md, 'Killzone / sesion') ||
    (() => {
      const m =
        md.match(/Killzone\s*\/\s*sesi[oó]n\s*\|\s*\*\*(.+?)\*\*/i) ||
        md.match(/Killzone\s*\/\s*sesi[oó]n\s*\|\s*([^|]+)\|/i);
      return m ? m[1] : null;
    })();

  const watchtower =
    extractField(md, 'Watchtower KZ') ||
    (() => {
      const m = md.match(/\|\s*Watchtower KZ\s*\|\s*([^|]+)\|/i);
      return m ? stripMd(m[1]) : null;
    })();

  const redFlags = [];
  const rfBlock = md.match(/###\s*Red flags\s*\n([\s\S]*?)(?:\n###|\n##|$)/i);
  if (rfBlock) {
    for (const line of rfBlock[1].split('\n')) {
      const t = line.replace(/^[-*]\s*/, '').trim();
      if (t && !t.startsWith('#')) redFlags.push(stripMd(t));
    }
  }

  const metrics = parseMetricsLine(md);
  const planDetails = parsePlanDetails(md);
  const scorecard = parseScorecard(md);
  const vol = parseVolumeZentinel(md);
  const thresholds = readVolumeThresholds(market);

  const checklist2M5 =
    parseChecklistSection(
      md,
      /##\s*Checklist 2M5\s*\n([\s\S]*?)(?:\n---|\n##\s|$)/i
    ) || [];
  // fallback: table under Checklist 2M5 if bullets empty
  let checklist2M5Final = checklist2M5;
  if (!checklist2M5Final.length) {
    checklist2M5Final = parseRulesTable(
      md,
      /##\s*Checklist 2M5\s*\n([\s\S]*?)(?:\n---|\n##\s|$)/i
    );
  }

  const checklistE1 = parseRulesTable(
    md,
    /###\s*Checklist E1\s*\n([\s\S]*?)(?:\n###|\n##\s|$)/i
  );

  // Context-tier soft fields
  const contextBias =
    (md.match(/Bias estructura M5:\s*\*\*([^*]+)\*\*/i) || [])[1] ||
    extractField(md, 'Modo bias');
  const impulso =
    (md.match(/Estado del impulso:\s*\*\*([^*]+)\*\*/i) || [])[1] || null;

  const combinedFromCard = scorecard.find((s) =>
    /combinado|probabilidad de [eé]xito/i.test(s.label)
  );

  const zentinel = {
    killzone: killzone ? stripMd(killzone) : null,
    watchtowerKz: watchtower,
    volBand: vol.band,
    volRatio: vol.ratio,
    preset: vol.preset || thresholds?.presetName || null,
    kzOn: watchtower
      ? !/fuera|off|lunch|asia|london/i.test(watchtower) &&
        /NY|ON|open|mid|pm/i.test(watchtower)
      : null,
    note:
      'TradingView no se lee en vivo. Presets Zentinel en config/zentinel_presets.yaml (checklist manual).',
  };

  // chart-ready score bars (prefer scorecard; else metrics)
  const chartScores = [];
  const pushScore = (label, value) => {
    if (value == null || Number.isNaN(value)) return;
    chartScores.push({ label, value: Math.max(0, Math.min(100, value)) });
  };
  if (scorecard.length) {
    for (const s of scorecard) {
      if (/combinado|probabilidad de [eé]xito/i.test(s.label)) continue;
      // Skip omitted layers (n/d) — do not paint a fake 0% Neural bar
      if (s.value == null) continue;
      if (/n\/d/i.test(s.raw || '') || /omitido/i.test(s.note || '')) continue;
      pushScore(s.label.replace(/\s*\(.*?\)\s*/g, '').slice(0, 28), s.value);
    }
    if (combinedFromCard?.value != null) {
      pushScore('Probabilidad de éxito', combinedFromCard.value);
    }
  } else {
    pushScore('Rules', metrics.rulesPct);
    pushScore('ML', metrics.mlPct);
    pushScore('Confluencia', metrics.confluencePct);
    pushScore('Score ext.', metrics.scoreExtended);
  }

  return {
    market,
    tier,
    ...parseDataFreshness(md),
    verdict: verdictMatch
      ? stripMd(verdictMatch[1])
      : extractField(md, 'Veredicto'),
    plan: plan || null,
    twoM5: twoM5 ? stripMd(twoM5) : null,
    redFlags: redFlags.slice(0, 10),
    zentinel,
    price: extractField(md, 'Precio'),
    entryOptima:
      extractField(md, 'Entrada óptima') ||
      extractField(md, 'Entrada optima') ||
      planDetails.entry,
    bias: contextBias ? stripMd(contextBias) : extractField(md, 'Modo bias'),
    setup: extractField(md, 'Modo setup'),
    impulso: impulso ? stripMd(impulso) : null,
    winrate:
      extractField(md, 'Winrate setup') ||
      extractField(md, 'Tasa de acierto'),
    rulesPct: metrics.rulesPct,
    mlPct: metrics.mlPct,
    confluencePct: metrics.confluencePct,
    confluenceLabel: metrics.confluenceLabel,
    scoreExtended: metrics.scoreExtended,
    scoreCombined:
      metrics.scoreCombined ??
      (combinedFromCard ? combinedFromCard.value : null),
    planDetails,
    checklist2M5: checklist2M5Final.slice(0, 10),
    checklistE1: checklistE1.slice(0, 10),
    rulesReview: parseRulesReview(md).slice(0, 12),
    probCalibrated: /calibrad[oa] walk-forward|tasa base \(sin ventaja OOS\)/i.test(
      combinedFromCard?.note || ''
    ),
    scorecard,
    chartScores: chartScores.slice(0, 8),
    volume: {
      band: vol.band,
      ratio: vol.ratio,
      preset: vol.preset || thresholds?.presetName || null,
      thresholds: thresholds
        ? {
            very_low: thresholds.very_low,
            low: thresholds.low,
            high: thresholds.high,
            extreme: thresholds.extreme,
          }
        : null,
    },
  };
}

/** Chart más reciente del mercado; si es de una corrida anterior al reporte no se expone. */
function latestChartInfo(key, chartNames, reportMtimeMs) {
  const chart = pickLatestChart(livePath(), chartNames);
  if (!chart) {
    return { chartPath: null, chartUrl: null, chartMtime: null, chartStale: false };
  }
  const chartStale = isChartStale(chart.mtimeMs, reportMtimeMs);
  return {
    chartPath: chartStale ? null : chart.full,
    chartUrl: chartStale
      ? null
      : `/api/signals/chart?market=${key}&v=${Math.round(chart.mtimeMs)}`,
    chartMtime: new Date(chart.mtimeMs).toISOString(),
    chartStale,
  };
}

function readLatest(market, tierHint) {
  const key = REPORTS[market] ? market : 'btc';
  const files = REPORTS[key];
  const preferred =
    (tierHint && files[tierHint]) || files.high || files.context;
  const candidates = [
    preferred,
    files.high,
    files.context,
    files.light,
  ].filter(Boolean);

  for (const name of candidates) {
    const full = livePath(name);
    if (fs.existsSync(full)) {
      const md = fs.readFileSync(full, 'utf8');
      const reportStat = fs.statSync(full);
      return {
        reportPath: full,
        reportName: name,
        ...latestChartInfo(key, files.chart, reportStat.mtimeMs),
        mtime: reportStat.mtime.toISOString(),
        summary: parseSummary(md, key, tierHint || 'high'),
        preview: md.slice(0, 50000),
      };
    }
  }
  return null;
}

function readZentinel(market) {
  const yamlPath = path.join(TRADING_ROOT, 'config', 'zentinel_presets.yaml');
  if (!fs.existsSync(yamlPath)) {
    return { available: false, error: 'No existe config/zentinel_presets.yaml' };
  }
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const key = zentinelYamlKey(market);
  // Extracción ligera sin dependencia yaml
  const sectionRe = new RegExp(`\\n\\s*${key}:([\\s\\S]*?)(?:\\n\\s{2}[A-Z]|\\n[a-z]|$)`);
  const sec = raw.match(sectionRe);
  const killzones = [];
  const kzBlock = raw.match(/killzones:([\s\S]*?)(?:\n\s{6}smt:|\n\s{4}[a-z]|$)/i);
  if (kzBlock) {
    for (const line of kzBlock[1].split('\n')) {
      const m = line.match(/name:\s*(\w+).*start:\s*"([^"]+)".*end:\s*"([^"]+)"/);
      if (m) killzones.push({ name: m[1], start: m[2], end: m[3] });
    }
  }
  return {
    available: true,
    market: key,
    path: yamlPath,
    killzonesSample: killzones.slice(0, 12),
    note: 'TV no en vivo — presets locales para confluencia / killzones.',
    snippet: (sec ? sec[0] : raw).slice(0, 1200),
  };
}

app.get('/api/health', (_req, res) => {
  const rootOk = fs.existsSync(TRADING_ROOT);
  res.json({
    ok: true,
    tradingRoot: TRADING_ROOT,
    tradingRootExists: rootOk,
    jobStatus: currentJob.status,
    platform: process.platform,
    signalsRunnable: SIGNALS_RUNNABLE,
    signalsNote: SIGNALS_RUNNABLE
      ? 'API en Windows: puede spawnear .ps1 del stack Cursor Trading.'
      : 'API en contenedor/no-Windows: health y lectura de live/ OK; para EJECUTAR señales usa run-api.ps1 en el host Windows.',
  });
});
app.get('/api/signals/status', (_req, res) => {
  res.json(publicJob(currentJob));
});

/** SSE: snapshot inmediato + job:started|progress|finished|failed. */
app.get('/api/signals/events', (req, res) => {
  jobEvents.attach(req, res, publicJob(currentJob));
});

app.get('/api/signals/latest', (req, res) => {
  const market = normalizeMarket(req.query.market);
  const tier = normalizeTier(req.query.tier) || 'high';
  if (!market) {
    return res.status(400).json({ error: MARKET_ERROR });
  }
  const latest = readLatest(market, tier);
  if (!latest) {
    return res.status(404).json({
      error: 'No hay reporte live aún. Ejecuta una señal primero.',
    });
  }
  res.json(latest);
});

app.get('/api/signals/chart', (req, res) => {
  const market = normalizeMarket(req.query.market);
  if (!market) {
    return res.status(400).json({ error: MARKET_ERROR });
  }
  if (!REPORTS[market]) {
    return res.status(404).json({
      error: 'Sin chart E1 para este mercado',
      market,
    });
  }
  const chartNames = REPORTS[market].chart;
  // path.resolve + join soporta espacios en "Cursor Trading"
  const liveRoot = path.resolve(path.join(TRADING_ROOT, 'live'));
  const chart = pickLatestChart(livePath(), chartNames);
  if (!chart) {
    return res.status(404).json({ error: 'PNG no encontrado', chart: chartNames });
  }
  const chartFull = path.resolve(chart.full);
  const underLive =
    chartFull === liveRoot ||
    chartFull.toLowerCase().startsWith(liveRoot.toLowerCase() + path.sep);
  if (!underLive) {
    return res.status(400).json({ error: 'path inválido' });
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(chartFull);
});

/** Mini-chart MACD-quant H4 (soft-filter) desde live/<sym>_h4_macd_quant.png */
app.get('/api/signals/macd-chart', (req, res) => {
  const market = normalizeMarket(req.query.market) || 'btc';
  if (!normalizeMarket(req.query.market) && req.query.market) {
    return res.status(400).json({ error: MARKET_ERROR });
  }
  // plot_macd_quant: xauusd→xau; ukoil→ukoil; resto = market API
  const fileKey = market === 'xauusd' ? 'xau' : market;
  const chartName = `${fileKey}_h4_macd_quant.png`;
  const liveRoot = path.resolve(path.join(TRADING_ROOT, 'live'));
  const chartFull = path.resolve(livePath(chartName));
  const underLive =
    chartFull === liveRoot ||
    chartFull.toLowerCase().startsWith(liveRoot.toLowerCase() + path.sep);
  if (!underLive) {
    return res.status(400).json({ error: 'path inválido' });
  }
  if (!fs.existsSync(chartFull)) {
    return res.status(404).json({
      error:
        'PNG MACD H4 no encontrado. Genera con: python -m scripts.plot_macd_quant --days 7 --force-refresh  o usa «Nuevo análisis»',
      chart: chartName,
    });
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(chartFull);
});

/**
 * Nuevo análisis MACD-quant: escaneo H4 de la semana (UTC now) + regenera PNG.
 * Spawna `python -m scripts.plot_macd_quant --symbol … --days 7 --force-refresh`.
 */
app.post('/api/signals/macd-quant/analyze', (req, res) => {
  if (currentJob.status === 'running') {
    return res.status(409).json({
      error: 'Ya hay un job en ejecución. Espera a que termine.',
      job: publicJob(currentJob),
    });
  }

  const body = { ...req.body };
  const market = normalizeMarket(body.market) || 'btc';
  if (!normalizeMarket(body.market) && body.market) {
    return res.status(400).json({ error: MARKET_ERROR });
  }

  if (!fs.existsSync(TRADING_ROOT)) {
    return res.status(500).json({
      error: 'CURSOR_TRADING_ROOT no existe o no es accesible',
    });
  }

  if (!SIGNALS_RUNNABLE) {
    return res.status(503).json({
      error:
        'Nuevo análisis requiere API en host Windows (run-api.ps1). El contenedor Linux solo cubre UI/health.',
      hint: String.raw`En el host Windows: .\run-api.ps1`,
      platform: process.platform,
    });
  }

  const cliSymbol = market === 'xauusd' ? 'xau' : market; // ukoil = ukoil
  const days = Number(body.days);
  const daysArg = Number.isFinite(days) && days > 0 ? String(days) : '7';
  const py = process.env.PYTHON || process.env.PYTHON_EXE || 'python';
  // --force-refresh: semana anclada a UTC now (no cola de parquet stale)
  const args = [
    '-m',
    'scripts.plot_macd_quant',
    '--symbol',
    cliSymbol,
    '--days',
    daysArg,
    '--force-refresh',
  ];
  const command = `${py} ${args.join(' ')}`;

  currentJob = {
    id: crypto.randomUUID(),
    status: 'running',
    kind: 'macd-quant',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    market,
    tier: 'macd-quant',
    command,
    exitCode: null,
    logs: [
      `>> ${command}`,
      `[info] Escaneo H4 · semana (~${daysArg}d) terminando UTC now · force-refresh · soft-filter E1 (nunca trigger)`,
    ],
    error: null,
    reportPath: null,
    summary: null,
    flags: { macdQuant: true, days: daysArg, forceRefresh: true },
    entry: null,
    historyId: null,
    macdQuantId: null,
    chartName: `${cliSymbol}_h4_macd_quant.png`,
    days: Number(daysArg),
  };
  const job = currentJob;
  jobEvents.broadcast(JOB_EVENTS.started, publicJob(job));

  const child = spawn(py, args, {
    cwd: TRADING_ROOT,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
    shell: false,
  });

  child.stdout.on('data', (d) => appendJobLogs(job, d, 'out'));
  child.stderr.on('data', (d) => appendJobLogs(job, d, 'err'));

  child.on('error', (err) => {
    currentJob.status = 'error';
    currentJob.finishedAt = new Date().toISOString();
    currentJob.error = err.message;
    currentJob.logs.push(`[error] ${err.message}`);
    announceJobEnd(job);
  });

  child.on('close', (code) => {
    currentJob.exitCode = code;
    currentJob.finishedAt = new Date().toISOString();
    const chartFull = livePath(currentJob.chartName);
    void (async () => {
      const ok = code === 0 && fs.existsSync(chartFull);
      if (ok) {
        currentJob.reportPath = chartFull;
        currentJob.logs.push(`[ok] PNG H4: ${currentJob.chartName}`);
      } else {
        currentJob.error =
          code === 0
            ? `PNG no generado: ${currentJob.chartName}`
            : `plot_macd_quant salió con código ${code}`;
        currentJob.logs.push(`[error] ${currentJob.error}`);
      }
      const finalStatus = ok ? 'done' : 'error';
      // Sigue en running hasta guardar → el poll recibe macdQuantId con done/error.
      await persistMacdQuantAnalysis(
        currentJob,
        ok ? chartFull : null,
        finalStatus
      );
      currentJob.status = finalStatus;
      announceJobEnd(job);
    })();
  });

  res.status(202).json({
    message: 'Nuevo análisis MACD H4 en ejecución (semana de mercado)…',
    job: publicJob(job),
  });
});

/**
 * Auto-guarda análisis MACD-quant en SQLite + copia durable del PNG.
 * @param {typeof currentJob} job
 * @param {string|null} chartFull
 * @param {string} [statusOverride]
 */
async function persistMacdQuantAnalysis(job, chartFull, statusOverride) {
  if (job.macdQuantPersisted) return;
  job.macdQuantPersisted = true;
  try {
    const logs = Array.isArray(job.logs) ? job.logs : [];
    const result = await macdQuantStore.insertAnalysis({
      market: job.market,
      timeframe: 'H4',
      days: job.days != null ? Number(job.days) : Number(job.flags?.days) || 7,
      status: statusOverride || job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      sourcePngPath: chartFull || null,
      command: job.command,
      exitCode: job.exitCode,
      error: job.error || null,
      softFilter: {
        macdQuant: true,
        days: job.days != null ? job.days : job.flags?.days,
        neverTriggerAlone: true,
      },
      params: macdQuantStore.DEFAULT_PARAMS,
      logsTail: logs.slice(-40).join('\n'),
    });
    job.macdQuantId = result.id;
    job.logs.push(
      result.pngName
        ? `[macd-quant] Guardado id=${result.id} · PNG durable: ${result.pngName}`
        : `[macd-quant] Guardado id=${result.id} (sin PNG)`
    );
  } catch (err) {
    job.logs.push(`[macd-quant] No se pudo guardar: ${err.message}`);
    console.error('[macd-quant] persist error:', err);
  }
}

/** Lista análisis MACD-quant preservados (filtro opcional por market). */
app.get('/api/signals/macd-quant/history', async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const marketQuery = req.query.market;
    const marketRaw =
      typeof marketQuery === 'string' ? marketQuery.toLowerCase() : null;
    if (marketRaw && !MARKETS.has(marketRaw)) {
      return res.status(400).json({ error: MARKET_ERROR });
    }
    const data = await macdQuantStore.listAnalyses({
      page,
      pageSize,
      market: marketRaw || null,
    });
    res.json(data);
  } catch (err) {
    console.error('[macd-quant] list:', err);
    res.status(500).json({ error: 'No se pudo leer el historial MACD-quant' });
  }
});

app.get('/api/signals/macd-quant/history/:id', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const item = await macdQuantStore.getById(id);
    if (!item) {
      return res.status(404).json({ error: 'Análisis no encontrado' });
    }
    res.json(item);
  } catch (err) {
    console.error('[macd-quant] get:', err);
    res.status(500).json({ error: 'No se pudo leer el análisis' });
  }
});

app.get('/api/signals/macd-quant/history/:id/chart', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const file = await macdQuantStore.getChartFile(id);
    if (!file) {
      return res.status(404).json({ error: 'PNG del análisis no encontrado' });
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(file.absPath);
  } catch (err) {
    console.error('[macd-quant] chart:', err);
    res.status(500).json({ error: 'No se pudo servir el PNG' });
  }
});

app.get('/api/zentinel', (req, res) => {
  const market = normalizeMarket(req.query.market);
  if (!market) {
    return res.status(400).json({ error: MARKET_ERROR });
  }
  res.json(readZentinel(market));
});

/** "3,7,12" → [3, 7, 12] (el store descarta lo que no sea id entero positivo). */
function queryIdList(raw) {
  return typeof raw === 'string' && raw ? raw.split(',') : [];
}

/** Historial local (SQLite hive box) — solo snapshots reales del pipeline. */
app.get('/api/history', async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const marketQuery = req.query.market;
    const marketRaw =
      typeof marketQuery === 'string' ? marketQuery.toLowerCase() : null;
    let market;
    if (marketRaw) {
      market = MARKETS.has(marketRaw) ? marketRaw : null;
    }
    if (marketRaw && market === null) {
      return res.status(400).json({ error: MARKET_ERROR });
    }
    const data = await historyStore.listHistory({
      page,
      pageSize,
      market: market || null,
      sortBy: typeof req.query.sortBy === 'string' ? req.query.sortBy : undefined,
      sortDir: typeof req.query.sortDir === 'string' ? req.query.sortDir : undefined,
      tagIds: queryIdList(req.query.tagIds),
      tagNone: req.query.tagNone === '1',
      confluenciaIds: queryIdList(req.query.confluenciaIds),
      confluenciaNone: req.query.confluenciaNone === '1',
    });
    res.json(data);
  } catch (err) {
    console.error('[history] list:', err);
    res.status(500).json({ error: 'No se pudo leer el historial local' });
  }
});

/** Catálogo de etiquetas Dirección (ex-Tags; seed incluye Dirección). Antes de /:id. */
app.get('/api/history/tags', async (_req, res) => {
  try {
    const tags = await historyStore.listTags();
    res.json({ tags });
  } catch (err) {
    console.error('[history] tags list:', err);
    res.status(500).json({ error: 'No se pudieron leer las etiquetas' });
  }
});

app.post('/api/history/tags', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await historyStore.createTag({
      name: body.name,
      color: body.color,
      sortOrder: body.sortOrder ?? body.sort_order,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo crear' });
    }
    res.status(result.created ? 201 : 200).json({
      ok: true,
      tag: result.tag,
      created: result.created,
    });
  } catch (err) {
    console.error('[history] tags create:', err);
    res.status(500).json({ error: 'No se pudo crear la etiqueta' });
  }
});

/** Catálogo de Confluencias (multi-select). Antes de /:id. */
app.get('/api/history/confluencias', async (_req, res) => {
  try {
    const confluencias = await historyStore.listConfluencias();
    res.json({ confluencias });
  } catch (err) {
    console.error('[history] confluencias list:', err);
    res.status(500).json({ error: 'No se pudieron leer las confluencias' });
  }
});

app.post('/api/history/confluencias', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await historyStore.createConfluencia({
      name: body.name,
      color: body.color,
      sortOrder: body.sortOrder ?? body.sort_order,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo crear' });
    }
    res.status(result.created ? 201 : 200).json({
      ok: true,
      confluencia: result.confluencia,
      created: result.created,
    });
  } catch (err) {
    console.error('[history] confluencias create:', err);
    res.status(500).json({ error: 'No se pudo crear la confluencia' });
  }
});

/** Barras de cambio de cálculo (corte en el grid). Antes de /:id. */
app.get('/api/history/calc-markers', async (req, res) => {
  try {
    const marketQuery = req.query.market;
    const marketRaw =
      typeof marketQuery === 'string' ? marketQuery.toLowerCase() : null;
    let market = null;
    if (marketRaw) {
      if (!MARKETS.has(marketRaw)) {
        return res.status(400).json({ error: MARKET_ERROR });
      }
      market = marketRaw;
    }
    const markers = await historyStore.listCalcMarkers({ market });
    res.json({ markers });
  } catch (err) {
    console.error('[history] calc-markers list:', err);
    res.status(500).json({ error: 'No se pudieron leer los marcadores' });
  }
});

app.post('/api/history/calc-markers', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await historyStore.createCalcMarker({
      title: body.title,
      comment: body.comment,
      market: body.market,
      createdAt: body.createdAt ?? body.created_at,
    });
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo crear' });
    }
    res.status(201).json({ ok: true, marker: result.marker });
  } catch (err) {
    console.error('[history] calc-markers create:', err);
    res.status(500).json({ error: 'No se pudo crear el marcador' });
  }
});

app.patch('/api/history/calc-markers/:id', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await historyStore.updateCalcMarker(id, {
      title: body.title,
      comment: body.comment,
      market: body.market,
    });
    if (!result.ok) {
      const code = /no encontrado/i.test(result.error || '') ? 404 : 400;
      return res.status(code).json({ error: result.error || 'No se pudo actualizar' });
    }
    res.json({ ok: true, marker: result.marker });
  } catch (err) {
    console.error('[history] calc-markers patch:', err);
    res.status(500).json({ error: 'No se pudo actualizar el marcador' });
  }
});

app.delete('/api/history/calc-markers/:id', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const result = await historyStore.deleteCalcMarker(id);
    if (!result.deleted) {
      return res.status(404).json({ error: 'Marcador no encontrado' });
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error('[history] calc-markers delete:', err);
    res.status(500).json({ error: 'No se pudo borrar el marcador' });
  }
});

/** Recalcula Probabilidad de éxito de todo el historial (blend acuerdo + ubicación). */
app.post('/api/history/recalc-probabilidad', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const marketQuery = body.market ?? req.query.market;
    const marketRaw =
      typeof marketQuery === 'string' && marketQuery.trim()
        ? marketQuery.toLowerCase()
        : null;
    let market = null;
    if (marketRaw) {
      if (!MARKETS.has(marketRaw)) {
        return res.status(400).json({ error: MARKET_ERROR });
      }
      market = marketRaw;
    }
    const result = await historyStore.recalcAllProbabilidad({
      force: Boolean(body.force),
      market,
    });
    res.json(result);
  } catch (err) {
    console.error('[history] recalc-probabilidad:', err);
    res.status(500).json({ error: 'No se pudo recalcular la probabilidad' });
  }
});

app.get('/api/history/:id', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const item = await historyStore.getById(id);
    if (!item) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    res.json(item);
  } catch (err) {
    console.error('[history] get:', err);
    res.status(500).json({ error: 'No se pudo leer el historial local' });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  if (!requireHistoryUnlock(req, res)) return;
  try {
    const result = await historyStore.deleteById(id);
    if (result.error === historyStore.LOCKED_ERROR) return sendHistoryLocked(res);
    if (!result.deleted) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error('[history] delete one:', err);
    res.status(500).json({ error: 'No se pudo borrar la entrada' });
  }
});

/** Candado: body { locked: true|false } sin otros campos; desbloquear siempre se permite. */
async function patchHistoryLock(id, body, res) {
  if (Object.keys(body).length > 1) {
    return res.status(400).json({ error: 'Envía locked solo, sin otros campos' });
  }
  try {
    const result = await historyStore.setLocked(id, body.locked);
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true, item: result.item });
  } catch (err) {
    console.error('[history] lock:', err);
    res.status(500).json({ error: 'No se pudo cambiar el candado de la fila' });
  }
}

/** Anotaciones trader: comment + motivoEntradaSalida + resultado + pnlUsd (o candado: locked). */
app.patch('/api/history/:id', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (Object.hasOwn(body, 'locked')) return patchHistoryLock(id, body, res);
  const patch = {};
  const hasOwn = (key) => Object.hasOwn(body, key);
  if (hasOwn('comment')) {
    patch.comment = body.comment;
  }
  if (hasOwn('motivoEntradaSalida')) {
    patch.motivoEntradaSalida = body.motivoEntradaSalida;
  } else if (hasOwn('motivo_entrada_salida')) {
    patch.motivoEntradaSalida = body.motivo_entrada_salida;
  }
  if (hasOwn('resultado')) {
    patch.resultado = body.resultado;
  }
  if (hasOwn('result') && patch.resultado === undefined) {
    patch.resultado = body.result;
  }
  if (hasOwn('pnlUsd')) {
    patch.pnlUsd = body.pnlUsd;
  } else if (hasOwn('pnl_usd')) {
    patch.pnlUsd = body.pnl_usd;
  } else if (hasOwn('pnlMoney')) {
    patch.pnlUsd = body.pnlMoney;
  }
  if (hasOwn('tagIds')) {
    patch.tagIds = body.tagIds;
  } else if (hasOwn('tag_ids')) {
    patch.tagIds = body.tag_ids;
  }
  if (hasOwn('confluenceIds')) {
    patch.confluenceIds = body.confluenceIds;
  } else if (hasOwn('confluenciaIds')) {
    patch.confluenceIds = body.confluenciaIds;
  } else if (hasOwn('confluencia_ids')) {
    patch.confluenceIds = body.confluencia_ids;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({
      error:
        'Envía comment, motivoEntradaSalida, resultado (ganada|perdida|no_tomada|vacío), pnlUsd, tagIds y/o confluenceIds',
    });
  }
  try {
    const result = await historyStore.updateAnnotation(id, patch, {
      reversalsEnabled: mt5Settings.get().reversalsEnabled === true,
    });
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    if (result.error === historyStore.LOCKED_ERROR) return sendHistoryLocked(res);
    if (result.error === historyStore.REVERSALS_DISABLED_ERROR) {
      return res.status(409).json({ error: result.message });
    }
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo actualizar' });
    }
    res.json({ ok: true, item: result.item });
  } catch (err) {
    console.error('[history] patch:', err);
    res.status(500).json({ error: 'No se pudo guardar el comentario/resultado' });
  }
});

/**
 * Captura del resultado: body JSON { imageBase64, mime? } (data-URL también ok).
 * Sin multer — archivo en data/history-attachments/.
 */
app.post('/api/history/:id/result-image', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let raw = body.imageBase64 ?? body.base64 ?? body.data ?? '';
  let mime = body.mime || body.contentType || '';
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'Envía imageBase64 (PNG/JPG/WebP/GIF)' });
  }
  raw = raw.trim();
  const dataUrl = /^data:([^;]+);base64,(.+)$/i.exec(raw);
  if (dataUrl) {
    mime = mime || dataUrl[1];
    raw = dataUrl[2];
  }
  let buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch {
    return res.status(400).json({ error: 'imageBase64 inválido' });
  }
  try {
    const result = await historyStore.saveResultImage(id, buffer, mime || 'image/png');
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    if (result.error === historyStore.LOCKED_ERROR) return sendHistoryLocked(res);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo guardar la imagen' });
    }
    res.json({ ok: true, item: result.item });
  } catch (err) {
    console.error('[history] result-image post:', err);
    res.status(500).json({ error: 'No se pudo guardar la imagen del resultado' });
  }
});

/** Filas con auto captura en curso (evita dos scripts sobre la misma fila). */
const autoCaptureInFlight = new Set();

/**
 * Auto captura: PNG de las velas reales tras la señal con Entrada/SL/TP, guardado como captura
 * del resultado. Body: { resultado? } (si falta, el de la fila). Nunca cambia el Resultado:
 * si el precio lo contradice devuelve mismatch + warning.
 */
/**
 * Genera y guarda la auto captura de una fila. → { status, body } (body.locked si la fila está bloqueada).
 * @param {number} id
 * @param {string|null|undefined} resultadoOverride resultado a comparar (por defecto el de la fila)
 */
async function autoCaptureRow(id, resultadoOverride) {
  if (autoCaptureInFlight.has(id)) {
    return { status: 409, body: { error: 'Ya se está generando la captura de esta señal' } };
  }
  if (!fs.existsSync(TRADING_ROOT)) {
    return { status: 503, body: { error: 'CURSOR_TRADING_ROOT no existe o no es accesible' } };
  }
  autoCaptureInFlight.add(id);
  try {
    const row = await historyStore.getById(id);
    if (row?.effectiveLocked) return { status: 423, body: { locked: true } };
    const sent = await sentWithExecutionTimes(id, row?.market);
    const resolved = autoCapture.resolveAutoCaptureInput(row, sent);
    if (!resolved.ok) {
      return { status: resolved.code === 'not_found' ? 404 : 422, body: { error: resolved.error, code: resolved.code } };
    }
    const run = await autoCapture.runAutoCapture({
      input: resolved.input,
      tradingRoot: TRADING_ROOT,
      workDir: path.join(historyStore.DATA_DIR, 'auto-capture'),
    });
    if (!run.ok) {
      console.warn(`[history] auto-capture #${id}:`, run.error);
      return { status: 422, body: { error: run.error, code: run.code || 'script' } };
    }
    const saved = await historyStore.saveResultImage(id, run.buffer, 'image/png');
    if (saved.error === historyStore.LOCKED_ERROR) return { status: 423, body: { locked: true } };
    if (!saved.ok) return { status: 400, body: { error: saved.error || 'No se pudo guardar la imagen' } };
    const check = autoCapture.compareOutcome(run.outcome, resultadoOverride ?? row.resultado);
    return { status: 200, body: { ok: true, item: saved.item, outcome: run.outcome, ...check } };
  } finally {
    autoCaptureInFlight.delete(id);
  }
}

/**
 * Envío MT5 de la fila (perfil activo primero) con precio/horas reales de cierre de la original y
 * del duplicado. Si faltan (envíos anteriores), los lee de /deals del puente y los guarda en mt5-sent.
 * Sin puente → el envío tal cual (el gráfico estima las horas con velas).
 */
async function sentWithExecutionTimes(historyId, market) {
  const key = `h${historyId}`;
  const active = mt5Settings.getActive();
  const profileId = [active, ...mt5Settings.PROFILES.filter((p) => p !== active)]
    .find((p) => mt5Sent.get(p, key)?.order);
  if (!profileId) return null;
  const sent = mt5Sent.get(profileId, key);
  if (!autoCapture.sentNeedsDeals(sent)) return sent;
  const settings = mt5Settings.get(profileId);
  const symbol = sent.symbol || settings.symbols?.[market];
  const fromMs = Date.parse(sent.at || '');
  if (!symbol || !Number.isFinite(fromMs)) return sent;
  const from = Math.floor(fromMs / 1000) - 120;
  const to = Math.min(Math.ceil(Date.now() / 1000), from + 60 * 86400);
  try {
    const data = await mt5.historyDeals({ symbol, from, to }, settings);
    const patch = autoCapture.sentPatchFromDeals(sent, data.deals || [], mt5.executionFromDeals);
    return patch ? mt5Sent.update(profileId, key, patch) : sent;
  } catch (err) {
    console.warn(`[history] auto-capture #${historyId}: deals MT5:`, err.message);
    return sent;
  }
}

app.post('/api/history/:id/auto-capture', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const { status, body } = await autoCaptureRow(id, req.body?.resultado);
    if (body.locked) return sendHistoryLocked(res);
    res.status(status).json(body);
  } catch (err) {
    console.error('[history] auto-capture:', err);
    res.status(500).json({ error: 'No se pudo generar la captura automática' });
  }
});

const MT5_PNL_STATUS = { not_found: 404, mt5_offline: 503, no_match: 404, open: 409, ambiguous: 409 };

/** Perfiles MT5 a consultar: el activo primero; uno por puente. */
function mt5PnlProfiles(historyId) {
  const active = mt5Settings.getActive();
  const ids = [active, ...mt5Settings.PROFILES.filter((p) => p !== active)];
  const byUrl = new Map();
  for (const id of ids) {
    const settings = mt5Settings.get(id);
    if (byUrl.has(settings.bridgeUrl)) continue;
    byUrl.set(settings.bridgeUrl, { id, settings, sentOrder: mt5Sent.get(id, `h${historyId}`)?.order ?? null });
  }
  return [...byUrl.values()];
}

/**
 * $/PnL real desde MT5 (Auto captura): suma profit+commission+swap+fee de la operación cerrada
 * que coincide con la señal y guarda su ejecución real (entrada, salida, horas, ticket).
 * Body: { resultado?, overwrite? }. Un PnL manual distinto solo se reemplaza con overwrite=true
 * (si no → needsConfirm). Nunca cambia el Resultado ni el plan.
 */
app.post('/api/history/:id/mt5-pnl', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const row = await historyStore.getById(id);
    if (row?.effectiveLocked) return sendHistoryLocked(res);
    const found = await mt5Pnl.lookupMt5Pnl({
      row,
      resultado: req.body?.resultado,
      profiles: mt5PnlProfiles(id),
      fetchDeals: mt5.historyDeals,
    });
    if (!found.ok) {
      return res.status(MT5_PNL_STATUS[found.code] || 422).json({ error: found.warning, code: found.code });
    }
    const { pnl } = found;
    const action = mt5Pnl.decideApply(row.pnlUsd, pnl.value, req.body?.overwrite === true);
    const real = { ticket: pnl.ticket, ...pnl.execution };
    const saved = await historyStore.updateMt5Execution(id, action === 'confirm' ? real : { ...real, pnlUsd: pnl.value });
    if (saved.error === historyStore.LOCKED_ERROR) return sendHistoryLocked(res);
    if (!saved.ok) return res.status(400).json({ error: saved.error || 'No se pudo guardar el PnL' });
    res.json({
      ok: true,
      applied: action === 'fill',
      needsConfirm: action === 'confirm',
      current: row.pnlUsd,
      pnl,
      item: saved.item,
    });
  } catch (err) {
    console.error('[history] mt5-pnl:', err);
    res.status(500).json({ error: 'No se pudo obtener el PnL de MT5' });
  }
});

app.get('/api/history/:id/result-image', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const file = await historyStore.getResultImageFile(id);
    if (!file) {
      return res.status(404).json({ error: 'Sin imagen de resultado' });
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.sendFile(file.absPath);
  } catch (err) {
    console.error('[history] result-image get:', err);
    res.status(500).json({ error: 'No se pudo leer la imagen' });
  }
});

app.delete('/api/history/:id/result-image', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  try {
    const result = await historyStore.deleteResultImage(id);
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    if (result.error === historyStore.LOCKED_ERROR) return sendHistoryLocked(res);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo borrar la imagen' });
    }
    res.json({ ok: true, item: result.item });
  } catch (err) {
    console.error('[history] result-image delete:', err);
    res.status(500).json({ error: 'No se pudo borrar la imagen del resultado' });
  }
});

app.delete('/api/history', async (req, res) => {
  if (!requireHistoryUnlock(req, res)) return;
  try {
    const result = await historyStore.clearAll();
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error('[history] clear:', err);
    res.status(500).json({ error: 'No se pudo limpiar el historial' });
  }
});

/** Wiki de artefactos Cursor AI — disco + meta local (SQLite). */
async function artifactsListHandler(_req, res) {
  try {
    const data = await artifacts.scanArtifacts();
    res.json(data);
  } catch (err) {
    console.error('[artifacts] scan:', err);
    res.status(500).json({ error: 'No se pudo escanear docs/Artifacts' });
  }
}

app.get('/api/artifacts', artifactsListHandler);
app.post('/api/artifacts/scan', artifactsListHandler);

app.get('/api/artifacts/item', async (req, res) => {
  try {
    const result = await artifacts.readArtifactMeta(req.query.path);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    const { ok, ...payload } = result;
    if (!ok) {
      return res.status(500).json({ error: 'Respuesta de artefacto inválida' });
    }
    res.json(payload);
  } catch (err) {
    console.error('[artifacts] item:', err);
    res.status(500).json({ error: 'No se pudo leer el artefacto' });
  }
});

/** Meta local: display_name, categoría; renameFile opcional (mismo dir). */
app.get('/api/artifacts/meta', async (req, res) => {
  try {
    if (req.query.path) {
      const meta = await wikiStore.getMeta(req.query.path);
      if (!meta) {
        return res.status(404).json({ error: 'Sin meta para ese path' });
      }
      return res.json(meta);
    }
    const items = await wikiStore.listMeta();
    res.json({ items });
  } catch (err) {
    console.error('[artifacts] meta get:', err);
    res.status(500).json({ error: 'No se pudo leer meta' });
  }
});

app.patch('/api/artifacts/meta', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await artifacts.patchArtifactMeta(body);
    if (!result.ok) {
      return res.status(result.status || 400).json({
        error: result.error,
        artifactCount: result.artifactCount,
      });
    }
    res.json({
      ok: true,
      path: result.path,
      pathChanged: !!result.pathChanged,
      oldPath: result.oldPath || null,
      meta: result.meta,
    });
  } catch (err) {
    console.error('[artifacts] meta patch:', err);
    res.status(500).json({ error: 'No se pudo guardar meta' });
  }
});

app.get('/api/wiki/categories', async (_req, res) => {
  try {
    const items = await wikiStore.listCategories();
    res.json({ items });
  } catch (err) {
    console.error('[wiki] categories list:', err);
    res.status(500).json({ error: 'No se pudieron listar categorías' });
  }
});

app.post('/api/wiki/categories', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await wikiStore.createCategory({
      name: body.name,
      sortOrder: body.sortOrder ?? body.sort_order,
      color: body.color,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.status(201).json({ ok: true, category: result.category });
  } catch (err) {
    console.error('[wiki] categories create:', err);
    res.status(500).json({ error: 'No se pudo crear la categoría' });
  }
});

app.patch('/api/wiki/categories/:id', async (req, res) => {
  try {
    const id = parseHistoryId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const body = req.body || {};
    const patch = {};
    if (Object.hasOwn(body, 'name')) patch.name = body.name;
    if (Object.hasOwn(body, 'sortOrder')) {
      patch.sortOrder = body.sortOrder;
    } else if (Object.hasOwn(body, 'sort_order')) {
      patch.sortOrder = body.sort_order;
    }
    if (Object.hasOwn(body, 'color')) patch.color = body.color;
    const result = await wikiStore.updateCategory(id, patch);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ ok: true, category: result.category });
  } catch (err) {
    console.error('[wiki] categories patch:', err);
    res.status(500).json({ error: 'No se pudo actualizar la categoría' });
  }
});

app.delete('/api/wiki/categories/:id', async (req, res) => {
  try {
    const id = parseHistoryId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id inválido' });
    }
    let reassignTo;
    if (Object.hasOwn(req.query, 'reassignTo')) {
      const raw = req.query.reassignTo;
      if (raw === '' || raw === 'null' || raw == null) {
        reassignTo = null;
      } else {
        const n = parseHistoryId(raw);
        if (!n) {
          return res.status(400).json({ error: 'reassignTo inválido' });
        }
        reassignTo = n;
      }
    }
    const force =
      req.query.force === '1' ||
      req.query.force === 'true' ||
      req.body?.force === true;
    const result = await wikiStore.deleteCategory(id, { reassignTo, force });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        artifactCount: result.artifactCount,
      });
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error('[wiki] categories delete:', err);
    res.status(500).json({ error: 'No se pudo borrar la categoría' });
  }
});

app.get('/api/artifacts/raw', (req, res) => {
  const resolved = artifacts.resolveSafe(req.query.path);
  if (!resolved.ok) {
    return res.status(resolved.status).json({ error: resolved.error });
  }
  let st;
  try {
    st = fs.statSync(resolved.full);
  } catch {
    return res.status(404).json({ error: 'Artefacto no encontrado' });
  }
  if (!st.isFile()) {
    return res.status(404).json({ error: 'Artefacto no encontrado' });
  }
  const ext = path.extname(resolved.full).toLowerCase();
  const mime = artifacts.MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Embeber solo same-origin (wiki iframe / PDF). Sin http: en img-src (hotspot).
  // HTML de artefactos: inline + fonts HTTPS; sin allow-same-origin+scripts en el iframe.
  const cspHtml =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: https:; frame-ancestors 'self'";
  const cspEmbed = "frame-ancestors 'self'";
  res.setHeader(
    'Content-Security-Policy',
    ext === '.html' || ext === '.htm' ? cspHtml : cspEmbed
  );
  res.sendFile(resolved.full);
});

registerVolatilityRoutes(app);

/** ?profile=principal|secundaria (por defecto el activo). */
app.get('/api/mt5/health', async (req, res) => {
  const profile = typeof req.query.profile === 'string' && req.query.profile ? req.query.profile : mt5Settings.getActive();
  if (!mt5Settings.PROFILES.includes(profile)) {
    return res.status(400).json({ ok: false, error: `profile debe ser ${mt5Settings.PROFILES.join(' | ')}` });
  }
  const settings = mt5Settings.get(profile);
  const { bridgeUrl } = settings;
  try {
    const bridge = await mt5.bridgeHealth(settings);
    res.json({ profile, bridgeUrl, ...bridge });
  } catch (err) {
    res.status(err.status || 503).json({ ok: false, profile, bridgeUrl, error: err.message });
  }
});

app.get('/api/mt5/settings', (_req, res) => {
  res.json({ ...mt5Settings.publicState(), defaults: mt5Settings.toPublic(mt5Settings.defaults()) });
});

/**
 * Configuración MT5 (pantalla Configuración):
 *  - { profile, settings }: patch parcial de un perfil (bridgeToken: '' lo borra)
 *  - { active }: perfil usado al enviar operaciones
 */
app.patch('/api/mt5/settings', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.active !== undefined && !mt5Settings.PROFILES.includes(body.active)) {
    return res.status(400).json({ error: `active debe ser ${mt5Settings.PROFILES.join(' | ')}` });
  }
  try {
    if (body.settings !== undefined) mt5Settings.update(body.settings, body.profile ?? mt5Settings.getActive());
    if (body.active !== undefined) mt5Settings.setActive(body.active);
    res.json({ ...mt5Settings.publicState(), defaults: mt5Settings.toPublic(mt5Settings.defaults()) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message, errors: err.errors });
    console.error('[mt5] settings:', err);
    res.status(500).json({ error: 'No se pudo guardar la configuración MT5' });
  }
});

/**
 * Envía a MT5 el plan de una señal. Origen: body.historyId → última corrida terminada
 * (si coincide body.market) → último reporte live/ de body.market.
 * La UI llama primero con dryRun=true (vista previa) y solo envía tras confirmar.
 * Opcionales: dryRun, volume, riskPct, allowMultiple, anyVerdict (solo con historyId: ejecuta el
 * plan aunque el veredicto no sea ENTRAR; el puente sigue validando desvío y rango SL/TP).
 */
/** Señal a enviar: historyId → job terminado → último reporte live/. → { key, market, summary } | { status, error }. */
async function resolvePushSource(body) {
  if (body.historyId != null) {
    const id = parseHistoryId(body.historyId);
    if (id == null) return { status: 400, error: 'historyId inválido' };
    const item = await historyStore.getById(id).catch(() => null);
    if (!item) return { status: 404, error: 'Entrada de historial no encontrada' };
    return { key: `h${id}`, market: item.market, summary: item.summary };
  }
  const wantedMarket = body.market == null ? null : normalizeMarket(body.market);
  if (body.market != null && !wantedMarket) return { status: 400, error: MARKET_ERROR };
  const jobUsable =
    currentJob.status === 'done' &&
    currentJob.kind === 'signal' &&
    currentJob.summary &&
    (!wantedMarket || currentJob.market === wantedMarket);
  if (jobUsable) {
    const key = currentJob.historyId ? `h${currentJob.historyId}` : currentJob.id.slice(0, 8);
    return { key, market: currentJob.market, summary: currentJob.summary };
  }
  if (!wantedMarket) {
    return { status: 409, error: 'No hay una señal terminada para enviar. Indica historyId o market.' };
  }
  const latest = readLatest(wantedMarket, 'high');
  if (!latest?.summary) return { status: 404, error: 'No hay reporte para ese mercado' };
  const key = `r${wantedMarket}${Math.round(fs.statSync(latest.reportPath).mtimeMs / 1000)}`;
  return { key, market: wantedMarket, summary: latest.summary };
}

/** dryRun / allowMultiple / volume / riskPct del body → { overrides } | { error }. */
function parsePushOverrides(body) {
  const overrides = { dry_run: body.dryRun === true, allow_multiple: body.allowMultiple === true };
  if (body.volume != null) {
    const volume = Number(body.volume);
    if (!Number.isFinite(volume) || volume <= 0) return { error: 'volume debe ser > 0' };
    overrides.volume = volume;
  }
  if (body.riskPct != null) {
    const riskPct = Number(body.riskPct);
    if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 5) return { error: 'riskPct debe estar entre 0 y 5' };
    overrides.risk_pct = riskPct;
  }
  return { overrides };
}

/** Run operation: solo la última señal y dentro de la ventana. → mensaje de rechazo o null. */
async function runWindowRejection(historyId) {
  const runnable = await runnableHistory().catch(() => null);
  if (runnable?.id !== parseHistoryId(historyId)) {
    return 'Run operation solo está disponible para la última señal.';
  }
  if (!runnable.open) {
    return `Pasaron más de ${MT5_RUN_WINDOW_MIN} min desde la señal: ya no se puede ejecutar.`;
  }
  return null;
}

app.post('/api/mt5/push', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const source = await resolvePushSource(body);
  if (source.error) return res.status(source.status).json({ error: source.error });
  const { key, market, summary } = source;

  const { overrides, error } = parsePushOverrides(body);
  if (error) return res.status(400).json({ error });

  const anyVerdict = body.anyVerdict === true && body.historyId != null;
  if (anyVerdict) {
    const rejection = await runWindowRejection(body.historyId);
    if (rejection) return res.status(409).json({ status: 'skipped', message: rejection });
  }
  const outcome = await pushSignalToMt5({ key, market, summary, overrides, anyVerdict });
  if (!overrides.dry_run && currentJob.summary === summary) {
    currentJob.mt5 = outcome;
    currentJob.logs.push(`[mt5] ${outcome.status}: ${outcome.message}`);
  }
  const status = { sent: 200, skipped: 409 }[outcome.status] || outcome.httpStatus || 502;
  res.status(status).json(outcome);
});

/**
 * Señales del historial ya enviadas a MT5 con el perfil activo y la única ejecutable desde
 * Run operation → { profile, sent: { [historyId]: {...} }, runnable: { id, at, expiresAt, open } | null }.
 */
app.get('/api/mt5/sent', async (_req, res) => {
  const profileId = mt5Settings.getActive();
  res.json({
    profile: { id: profileId, label: mt5Settings.PROFILE_LABELS[profileId] },
    sent: mt5Sent.historyMap(profileId),
    runnable: await runnableHistory().catch(() => null),
  });
});

const CHART_ASSET = { btc: 'BTC', us30: 'US30', xauusd: 'XAUUSD' };
const CHART_DECIMALS = { btc: 1, us30: 1, xauusd: 2 };

/**
 * Redibuja la «Captura detalle» (PNG anotado de live/) con los niveles reajustados.
 * Solo para la última señal de su mercado: el PNG de live/ es el de esa corrida.
 * @returns {Promise<{ updated: boolean, reason?: string, chartUrl?: string }>}
 */
async function rerenderDetailChart(id, levels, sent, settings = mt5Settings.get()) {
  const row = await historyStore.getById(id);
  const asset = row && CHART_ASSET[row.market];
  if (row?.effectiveLocked) return { updated: false, reason: 'fila bloqueada' };
  if (!asset || !row.chartPath) return { updated: false, reason: 'sin captura detalle' };
  const latest = await historyStore.listHistory({
    page: 1, pageSize: 1, market: row.market, sortBy: 'createdAt', sortDir: 'desc',
  });
  if (latest?.items?.[0]?.id !== id) return { updated: false, reason: 'no es la última señal del mercado' };
  const liveRoot = path.resolve(livePath());
  const chartFull = path.resolve(row.chartPath);
  if (!chartFull.toLowerCase().startsWith(liveRoot.toLowerCase() + path.sep) || !fs.existsSync(chartFull)) {
    return { updated: false, reason: 'PNG no encontrado en live/' };
  }
  const nums = [levels.entry, levels.sl, levels.tp].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return { updated: false, reason: 'niveles incompletos' };

  const hhmm = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  const args = [
    '-m', 'app.views.chart_rerender',
    '--chart', chartFull,
    '--entry', String(nums[0]), '--sl', String(nums[1]), '--tp', String(nums[2]),
    '--note', `Reajustado con MT5 · ticket ${sent.order} · ${hhmm}`,
    '--asset', asset,
    '--until', row.finishedAt || row.createdAt,
    '--decimals', String(CHART_DECIMALS[row.market]),
  ];
  if (sent.state) args.push('--order-state', String(sent.state));
  const direction = sent.side || row.summary?.direction;
  if (direction) args.push('--direction', String(direction).toUpperCase());
  if (row.verdict) args.push('--verdict', String(row.verdict));
  const price = Number(row.summary?.price);
  if (Number.isFinite(price)) args.push('--price', String(price));

  const py = process.env.PYTHON || process.env.PYTHON_EXE || 'python';
  const out = await new Promise((resolve) => {
    const child = spawn(py, args, {
      cwd: TRADING_ROOT,
      env: { ...process.env, ...mt5.brokerFeedEnv(settings), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).pop() || '';
      try { resolve(JSON.parse(line)); } catch { resolve({ ok: false, error: 'salida inválida del script' }); }
    });
  });
  if (!out.ok) return { updated: false, reason: out.error || 'error al redibujar' };
  const mtime = Math.round(fs.statSync(chartFull).mtimeMs);
  return { updated: true, chartUrl: `/api/signals/chart?market=${row.market}&v=${mtime}` };
}

/**
 * Recalcular una operación ya enviada (Run operation): lee su estado real en MT5 y reajusta
 * el historial (Entrada/SL/TP del plan; Resultado y $/PnL si se cerró o canceló).
 * Body: { historyId }.
 */
app.post('/api/mt5/recalc', async (req, res) => {
  const id = parseHistoryId(req.body?.historyId);
  if (id == null) return res.status(400).json({ error: 'historyId inválido' });
  const profileId = mt5Settings.getActive();
  const settings = mt5Settings.get(profileId);
  const key = `h${id}`;
  const sent = mt5Sent.get(profileId, key);
  if (!sent?.order) {
    return res.status(404).json({ error: `La señal #${id} no se envió a MT5 con ${mt5Settings.PROFILE_LABELS[profileId]}` });
  }
  try {
    const row = await historyStore.getById(id);
    if (row?.effectiveLocked) return sendHistoryLocked(res);
    const status = await mt5.orderStatus(sent.order, settings);
    const rec = mt5.reconcileOrder(sent, status);
    const dup = await reconcileDuplicate(sent.duplicate, settings);
    const annotation = sent.duplicate?.order
      ? mt5.combineAnnotations(rec.annotation, dup.rec?.annotation)
      : rec.annotation;

    const failed = await applyRecalcToRow(id, rec.levels, annotation);
    if (failed?.locked) return sendHistoryLocked(res);
    if (failed) return res.status(failed.status).json({ error: failed.error });
    const patch = dup.rec ? { ...rec.sentPatch, duplicate: { ...sent.duplicate, ...dup.rec.sentPatch } } : rec.sentPatch;
    const updated = mt5Sent.update(profileId, key, patch);
    const chart = await rerenderDetailChart(id, rec.levels, updated, settings).catch((err) => ({
      updated: false,
      reason: err.message,
    }));
    const capture = await autoCaptureOnResult(id, row, annotation);
    res.json({
      ok: true,
      message: recalcMessage(rec, dup, sent.duplicate?.order ? annotation : null),
      changes: rec.changes,
      status,
      sent: updated,
      annotation,
      chart,
      capture,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, details: err.details });
  }
});

/**
 * Recalcular → fila: niveles del plan y, si hay, Resultado/$/PnL. El store rechaza filas con candado.
 * @returns {Promise<null | { locked: true } | { status: number, error: string }>} null si se aplicó
 */
async function applyRecalcToRow(id, levels, annotation) {
  const plan = await historyStore.updatePlanLevels(id, levels);
  if (plan.error === historyStore.LOCKED_ERROR) return { locked: true };
  if (!plan.ok) return { status: plan.error === 'not_found' ? 404 : 400, error: plan.error };
  if (!annotation) return null;
  const ann = await historyStore.updateAnnotation(id, annotation);
  if (ann.error === historyStore.LOCKED_ERROR) return { locked: true };
  return ann.ok ? null : { status: 400, error: ann.error };
}

/** Estado real del duplicado (si existe). → { rec?, error? } */
async function reconcileDuplicate(duplicate, settings) {
  if (!duplicate?.order) return {};
  try {
    const status = await mt5.orderStatus(duplicate.order, settings);
    return { rec: mt5.reconcileOrder(duplicate, status) };
  } catch (err) {
    return { error: err.message };
  }
}

function recalcMessage(rec, dup, combined) {
  const parts = [rec.message];
  if (dup.rec) parts.push(`Duplicada: ${dup.rec.message}`);
  else if (dup.error) parts.push(`Duplicada: ${dup.error}`);
  if (combined?.pnlUsd != null) parts.push(`Total ${combined.pnlUsd} USD (${combined.resultado})`);
  return parts.join(' · ');
}

/**
 * Auto captura al cerrarse la operación: solo si Recalcular cambia el Resultado a ganada/perdida
 * y la fila aún no tiene captura (no pisa una subida a mano).
 */
async function autoCaptureOnResult(id, row, annotation) {
  const resultado = annotation?.resultado;
  if (!row || (resultado !== 'ganada' && resultado !== 'perdida')) return null;
  if (resultado === row.resultado || row.hasResultImage) return null;
  try {
    const { body } = await autoCaptureRow(id, resultado);
    if (body.ok) return { ok: true, warning: body.warning ?? null };
    return { ok: false, error: body.locked ? 'Fila bloqueada' : body.error };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Duplicados en curso (perfil:clave): evita dos segundas operaciones por doble clic. */
const mt5DuplicateInFlight = new Set();

/**
 * Duplicar una operación ya enviada: segunda orden con el mismo lote y los niveles actuales de la
 * original (LIMIT si sigue pendiente o expiró, mercado si ya está abierta). Solo una vez por señal,
 * salvo que el duplicado anterior expirara: se reemplaza y el viejo queda en duplicateHistory.
 * Body: { historyId }.
 */
app.post('/api/mt5/duplicate', async (req, res) => {
  const id = parseHistoryId(req.body?.historyId);
  if (id == null) return res.status(400).json({ error: 'historyId inválido' });
  const profileId = mt5Settings.getActive();
  const settings = mt5Settings.get(profileId);
  const label = mt5Settings.PROFILE_LABELS[profileId];
  const key = `h${id}`;
  const sent = mt5Sent.get(profileId, key);
  if (!sent?.order) return res.status(404).json({ error: `La señal #${id} no se envió a MT5 con ${label}` });
  if (sent.duplicate && sent.duplicate.state !== 'expired') {
    return res.status(409).json({ error: `La señal #${id} ya está duplicada` });
  }
  const lockKey = `${profileId}:${key}`;
  if (mt5DuplicateInFlight.has(lockKey)) return res.status(409).json({ error: 'Ya se está duplicando esta operación' });
  mt5DuplicateInFlight.add(lockKey);
  try {
    const status = await mt5.orderStatus(sent.order, settings);
    const { order, error } = mt5.buildDuplicateOrder(sent, status);
    if (!order) return res.status(409).json({ error });
    const history = sent.duplicate ? [...(sent.duplicateHistory ?? []), sent.duplicate] : sent.duplicateHistory;
    const clientId = history?.length ? `${key}d${history.length + 1}` : `${key}d`;
    const result = await mt5.pushDuplicateOrder(order, { clientId }, settings);
    const patch = { duplicate: mt5Sent.entryOf(result) };
    if (history) patch.duplicateHistory = history;
    const updated = mt5Sent.update(profileId, key, patch);
    const how = result.mode === 'market' ? 'mercado' : 'LIMIT';
    res.json({
      ok: true,
      message: `Duplicada: ${order.side} ${result.symbol} ${result.volume} lotes · ${how} @ ${result.price} · SL ${result.sl ?? '—'} · TP ${result.tp ?? '—'} · ticket ${result.order}`,
      sent: updated,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, details: err.details });
  } finally {
    mt5DuplicateInFlight.delete(lockKey);
  }
});

/**
 * Orden manual con el perfil activo: sin veredicto, deduplicado, desvío broker↔entrada,
 * rango SL/TP ni exposición previa. Siguen aplicando token, bloqueo de cuenta REAL y Algo Trading.
 * Body: market|symbol, side, orderMode (market|limit|stop|auto), entry, sl, tp, volume, dryRun.
 */
app.post('/api/mt5/manual', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const profileId = mt5Settings.getActive();
  const settings = mt5Settings.get(profileId);
  const profile = { id: profileId, label: mt5Settings.PROFILE_LABELS[profileId] };
  const { order, error } = mt5.buildManualOrder(body, settings);
  if (!order) return res.status(400).json({ status: 'error', message: error, profile });

  const dryRun = body.dryRun === true;
  try {
    const result = await mt5.pushOrder(order, { clientId: 'manual', dry_run: dryRun }, settings);
    const how = { market: 'mercado', pending: 'LIMIT', stop: 'STOP' }[result.mode] || result.mode;
    const stops = `SL ${result.sl ?? '—'} · TP ${result.tp ?? '—'}`;
    res.json({
      status: 'sent',
      message: `${order.side} ${result.symbol} ${result.volume} lotes · ${how} @ ${result.price} · ${stops} · ${profile.label}${dryRun ? ' (dry-run)' : ''}${volumeNoteSuffix(result)}`,
      order,
      result,
      profile,
    });
  } catch (err) {
    res.status(err.status || 502).json({ status: 'error', message: err.message, order, profile, details: err.details });
  }
});

app.post('/api/signals/run', (req, res) => {
  if (currentJob.status === 'running') {
    return res.status(409).json({
      error: 'Ya hay una señal en ejecución. Espera a que termine.',
      job: publicJob(currentJob),
    });
  }

  const body = { ...req.body };
  const market = normalizeMarket(body.market);
  const tier = normalizeTier(body.tier);

  if (!market) {
    return res.status(400).json({ error: MARKET_ERROR });
  }
  if (!SIGNAL_MARKETS.has(market)) {
    return res.status(400).json({
      error: `market=${market} solo soporta MACD-quant (sin pipeline E1). Usa /macd-quant.`,
      hint: 'POST /api/signals/macd-quant/analyze',
    });
  }
  if (!tier) {
    return res.status(400).json({
      error: 'tier debe ser context|light|high|history',
    });
  }

  const entry = sanitizeEntry(body.entry);
  if (body.entry != null && String(body.entry).trim() !== '' && entry === undefined) {
    return res.status(400).json({
      error: 'entry debe ser un número (ej. 97450.5)',
    });
  }
  body.entry = entry;
  body.market = market;
  body.tier = tier;

  if (!fs.existsSync(TRADING_ROOT)) {
    return res.status(500).json({
      error: 'CURSOR_TRADING_ROOT no existe o no es accesible',
    });
  }

  const script = scriptFor(market, tier);
  const scriptsRoot = path.resolve(path.join(TRADING_ROOT, 'scripts', 'analyze'));
  const scriptResolved = script ? path.resolve(script) : null;
  const underScripts =
    scriptResolved &&
    (scriptResolved === scriptsRoot ||
      scriptResolved.toLowerCase().startsWith(scriptsRoot.toLowerCase() + path.sep));
  if (!scriptResolved || !underScripts || !fs.existsSync(scriptResolved)) {
    return res.status(500).json({
      error: `Script no encontrado para market=${market} tier=${tier}`,
    });
  }

  // «Tendencia actual»: el bias se resuelve tras crear el job (detector H1) y antes del .ps1.
  const wantsTrend = !!body.trendBias && !body.bullish && !body.bearish && tier !== 'context';
  body.trendBias = wantsTrend;
  const command = signalCommand(scriptResolved, buildPsArgs(body));

  if (!SIGNALS_RUNNABLE) {
    return res.status(503).json({
      error:
        'Señales reales requieren API en host Windows (run-api.ps1). El contenedor Linux solo cubre UI/health.',
      hint: String.raw`En el host Windows: .\run-api.ps1  y  .\run-docker.ps1 -HostApi`,
      platform: process.platform,
      command,
    });
  }

  const env = { ...process.env, ...mt5.brokerFeedEnv(), PYTHONIOENCODING: 'utf-8' };
  currentJob = {
    id: crypto.randomUUID(),
    kind: 'signal',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    market,
    tier,
    command,
    exitCode: null,
    logs: wantsTrend
      ? [`[bias] Detectando tendencia H1 actual de ${market.toUpperCase()}…`]
      : [`>> ${command}`],
    error: null,
    reportPath: null,
    summary: null,
    flags: flagsFromBody(body),
    trendBias: null,
    entry: body.entry ?? null,
    historyId: null,
    mt5: null,
  };
  const job = currentJob;
  jobEvents.broadcast(JOB_EVENTS.started, publicJob(job));

  if (wantsTrend) {
    const py = process.env.PYTHON || process.env.PYTHON_EXE || 'python';
    void trendBias
      .detectTrendBias({ py, cwd: TRADING_ROOT, env, market })
      .then(({ result, error }) => {
        const decision = trendBias.trendBiasDecision(result, error);
        body.bullish = decision.flag === 'bullish';
        body.bearish = decision.flag === 'bearish';
        job.flags = flagsFromBody(body);
        job.trendBias = {
          bias: decision.bias,
          label: decision.label,
          flag: decision.flag,
          method: decision.method,
          source: result?.source ?? null,
        };
        job.command = signalCommand(scriptResolved, buildPsArgs(body));
        pushJobLines(job, [decision.log, `>> ${job.command}`]);
        launchSignalScript(job, scriptResolved, buildPsArgs(body), env);
      });
  } else {
    launchSignalScript(job, scriptResolved, buildPsArgs(body), env);
  }

  res.status(202).json({
    message: 'Señal iniciada',
    job: publicJob(job),
  });
});

function signalCommand(scriptResolved, psArgs) {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptResolved}" ${psArgs.join(' ')}`;
}

/** Líneas propias de la API en el log del job (emitidas como job:progress). */
function pushJobLines(job, lines) {
  job.logs.push(...lines);
  jobEvents.broadcast(JOB_EVENTS.progress, { id: job.id, lines });
}

function launchSignalScript(job, scriptResolved, psArgs, env) {
  const { market, tier } = job;
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptResolved, ...psArgs],
    {
      cwd: TRADING_ROOT,
      env,
      windowsHide: true,
      shell: false,
    }
  );

  child.stdout.on('data', (d) => appendJobLogs(job, d, 'out'));
  child.stderr.on('data', (d) => appendJobLogs(job, d, 'err'));

  child.on('error', (err) => {
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.error = err.message;
    job.logs.push(`[error] ${err.message}`);
    void persistJobSnapshot(job).then(() => announceJobEnd(job));
  });

  child.on('close', (code) => {
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    if (code === 0) {
      job.status = 'done';
      const latest = readLatest(market, tier);
      if (latest) {
        job.reportPath = latest.reportPath;
        job.summary = latest.summary;
        job.logs.push(`[ok] Reporte: ${latest.reportPath}`);
      } else {
        job.logs.push('[warn] Proceso OK pero no se encontró reporte live.');
      }
    } else {
      job.status = 'error';
      job.error = `El script terminó con código ${code}`;
      job.logs.push(`[error] exit ${code}`);
    }
    // El fin se emite tras persistir → el cliente recibe historyId.
    void persistJobSnapshot(job).then(() => announceJobEnd(job));
  });
}

void Promise.all([
  historyStore.init(),
  wikiStore.init(),
  macdQuantStore.init(),
])
  .then(() => {
    app.listen(PORT, BIND_HOST, () => {
      console.log(`Flash Signals API → http://${BIND_HOST}:${PORT}`);
      console.log(`CURSOR_TRADING_ROOT = ${TRADING_ROOT}`);
      console.log(`Existe: ${fs.existsSync(TRADING_ROOT)}`);
      console.log(`Historial (hive box): ${historyStore.DB_PATH}`);
      console.log(`Wiki meta: ${wikiStore.DB_PATH}`);
      console.log(`MACD-quant historial: ${macdQuantStore.DB_PATH}`);
      console.log(`MACD-quant PNG: ${macdQuantStore.CHARTS_DIR}`);
    });
  })
  .catch((err) => {
    console.error('[init] No se pudo abrir SQLite local:', err);
    process.exit(1);
  });
