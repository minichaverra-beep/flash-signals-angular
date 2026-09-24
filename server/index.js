/**
 * API local — orquesta scripts de Cursor Trading (PowerShell).
 * No genera señales fake: solo spawnea el pipeline real.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const historyStore = require('./db/history-store');
const wikiStore = require('./db/wiki-store');
const artifacts = require('./artifacts');

const PORT = Number(process.env.PORT || 3847);
/** Solo loopback: API local, no exponer a la LAN. */
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const TRADING_ROOT =
  process.env.CURSOR_TRADING_ROOT ||
  path.normalize('D:\\Danilo\\Trading\\Cursor Trading');

/** Contraseña para borrar filas / limpiar historial (modo lock). */
const HISTORY_UNLOCK_PASSWORD =
  process.env.HISTORY_UNLOCK_PASSWORD || 'Elxokas2026*';

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
const MARKETS = new Set(['btc', 'us30', 'xauusd']);
const TIERS = new Set(['context', 'light', 'high', 'history']);
const MARKET_ERROR = 'market debe ser btc|us30|xauusd';

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
    // Controller XAU aún no genera *_chart_annotated; usa el chart crudo.
    chart: 'xauusd_m5_chart.png',
  },
};

/** Clave YAML Zentinel por market (sección en config/zentinel_presets.yaml). */
function zentinelYamlKey(market) {
  if (market === 'us30') return 'US30';
  if (market === 'xauusd') return 'XAUUSD';
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
};

/** Valida id numérico entero positivo (path param). */
function parseHistoryId(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || String(raw).trim() !== String(n)) {
    return null;
  }
  return n;
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

const app = express();
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
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\u00a0/g, ' ')
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
      const label = stripMd(cells[0] || '').replace(/^\*\*|\*\*$/g, '');
      const raw = stripMd(cells[1] || '');
      const weight = stripMd(cells[2] || '');
      const note = stripMd(cells[3] || '');
      let value = parsePct(raw);
      if (value == null) {
        const frac = raw.match(/(\d+)\s*\/\s*(\d+)/);
        if (frac) value = Math.round((Number(frac[1]) / Number(frac[2])) * 1000) / 10;
      }
      if (value == null && /fail|n\/d|omit/i.test(raw)) value = 0;
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
  const preset = parts.find((p) => /zentinel/i.test(p)) || parts[parts.length - 1] || null;
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
    /combinado/i.test(s.label)
  );

  const zentinel = {
    killzone: killzone ? stripMd(killzone) : null,
    watchtowerKz: watchtower,
    volBand: vol.band,
    volRatio: vol.ratio,
    preset: vol.preset || (thresholds && thresholds.presetName) || null,
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
      if (/combinado/i.test(s.label)) continue;
      if (s.value != null) pushScore(s.label.replace(/\s*\(.*?\)\s*/g, '').slice(0, 28), s.value);
    }
    if (combinedFromCard?.value != null) pushScore('Combinado', combinedFromCard.value);
  } else {
    pushScore('Rules', metrics.rulesPct);
    pushScore('ML', metrics.mlPct);
    pushScore('Confluencia', metrics.confluencePct);
    pushScore('Score ext.', metrics.scoreExtended);
  }

  return {
    market,
    tier,
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
    winrate: extractField(md, 'Winrate setup'),
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
    scorecard,
    chartScores: chartScores.slice(0, 8),
    volume: {
      band: vol.band,
      ratio: vol.ratio,
      preset: vol.preset || (thresholds && thresholds.presetName) || null,
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
      const chartName = files.chart;
      const chartFull = livePath(chartName);
      const chartExists = fs.existsSync(chartFull);
      return {
        reportPath: full,
        reportName: name,
        chartPath: chartExists ? chartFull : null,
        chartUrl: chartExists ? `/api/signals/chart?market=${key}` : null,
        mtime: fs.statSync(full).mtime.toISOString(),
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
  res.json(currentJob);
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
  const chartName = REPORTS[market].chart;
  // path.resolve + join soporta espacios en "Cursor Trading"
  const liveRoot = path.resolve(path.join(TRADING_ROOT, 'live'));
  const chartFull = path.resolve(livePath(chartName));
  const underLive =
    chartFull === liveRoot ||
    chartFull.toLowerCase().startsWith(liveRoot.toLowerCase() + path.sep);
  if (!underLive) {
    return res.status(400).json({ error: 'path inválido' });
  }
  if (!fs.existsSync(chartFull)) {
    return res.status(404).json({ error: 'PNG no encontrado', chart: chartName });
  }
  res.setHeader('Content-Type', 'image/png');
  res.sendFile(chartFull);
});

app.get('/api/zentinel', (req, res) => {
  const market = normalizeMarket(req.query.market);
  if (!market) {
    return res.status(400).json({ error: MARKET_ERROR });
  }
  res.json(readZentinel(market));
});

/** Historial local (SQLite hive box) — solo snapshots reales del pipeline. */
app.get('/api/history', async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 20;
    const marketRaw = req.query.market
      ? String(req.query.market).toLowerCase()
      : null;
    const market =
      marketRaw && MARKETS.has(marketRaw) ? marketRaw : marketRaw ? null : undefined;
    if (marketRaw && market === null) {
      return res.status(400).json({ error: MARKET_ERROR });
    }
    const data = await historyStore.listHistory({
      page,
      pageSize,
      market: market || null,
    });
    res.json(data);
  } catch (err) {
    console.error('[history] list:', err);
    res.status(500).json({ error: 'No se pudo leer el historial local' });
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
    if (!result.deleted) {
      return res.status(404).json({ error: 'Entrada no encontrada' });
    }
    res.json({ ok: true, deleted: result.deleted });
  } catch (err) {
    console.error('[history] delete one:', err);
    res.status(500).json({ error: 'No se pudo borrar la entrada' });
  }
});

/** Anotaciones trader: comment + resultado (ganada|perdida). */
app.patch('/api/history/:id', async (req, res) => {
  const id = parseHistoryId(req.params.id);
  if (id == null) {
    return res.status(400).json({ error: 'id inválido' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'comment')) {
    patch.comment = body.comment;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'resultado')) {
    patch.resultado = body.resultado;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'result') && patch.resultado === undefined) {
    patch.resultado = body.result;
  }
  if (!Object.keys(patch).length) {
    return res.status(400).json({
      error: 'Envía comment y/o resultado (ganada|perdida|vacío)',
    });
  }
  try {
    const result = await historyStore.updateAnnotation(id, patch);
    if (!result.ok && result.error === 'not_found') {
      return res.status(404).json({ error: 'Entrada no encontrada' });
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
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'No se pudo guardar la imagen' });
    }
    res.json({ ok: true, item: result.item });
  } catch (err) {
    console.error('[history] result-image post:', err);
    res.status(500).json({ error: 'No se pudo guardar la imagen del resultado' });
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
    const { ok: _ok, ...payload } = result;
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
    if (Object.prototype.hasOwnProperty.call(body, 'name')) patch.name = body.name;
    if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
      patch.sortOrder = body.sortOrder;
    } else if (Object.prototype.hasOwnProperty.call(body, 'sort_order')) {
      patch.sortOrder = body.sort_order;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'color')) patch.color = body.color;
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
    let reassignTo = undefined;
    if (Object.prototype.hasOwnProperty.call(req.query, 'reassignTo')) {
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

app.post('/api/signals/run', (req, res) => {
  if (currentJob.status === 'running') {
    return res.status(409).json({
      error: 'Ya hay una señal en ejecución. Espera a que termine.',
      job: currentJob,
    });
  }

  const body = { ...(req.body || {}) };
  const market = normalizeMarket(body.market);
  const tier = normalizeTier(body.tier);

  if (!market) {
    return res.status(400).json({ error: MARKET_ERROR });
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

  const psArgs = buildPsArgs(body);
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptResolved}" ${psArgs.join(' ')}`;

  if (!SIGNALS_RUNNABLE) {
    return res.status(503).json({
      error:
        'Señales reales requieren API en host Windows (run-api.ps1). El contenedor Linux solo cubre UI/health.',
      hint: 'En el host Windows: .\\run-api.ps1  y  .\\run-docker.ps1 -HostApi',
      platform: process.platform,
      command,
    });
  }

  currentJob = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    market,
    tier,
    command,
    exitCode: null,
    logs: [`>> ${command}`],
    error: null,
    reportPath: null,
    summary: null,
    flags: flagsFromBody(body),
    entry: body.entry ?? null,
    historyId: null,
  };

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptResolved, ...psArgs],
    {
      cwd: TRADING_ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      shell: false,
    }
  );

  const pushLog = (chunk, stream) => {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      currentJob.logs.push(`[${stream}] ${line}`);
      if (currentJob.logs.length > 500) currentJob.logs.shift();
    }
  };

  child.stdout.on('data', (d) => pushLog(d, 'out'));
  child.stderr.on('data', (d) => pushLog(d, 'err'));

  child.on('error', (err) => {
    currentJob.status = 'error';
    currentJob.finishedAt = new Date().toISOString();
    currentJob.error = err.message;
    currentJob.logs.push(`[error] ${err.message}`);
    void persistJobSnapshot(currentJob);
  });

  child.on('close', (code) => {
    currentJob.exitCode = code;
    currentJob.finishedAt = new Date().toISOString();
    if (code === 0) {
      currentJob.status = 'done';
      const latest = readLatest(market, tier);
      if (latest) {
        currentJob.reportPath = latest.reportPath;
        currentJob.summary = latest.summary;
        currentJob.logs.push(`[ok] Reporte: ${latest.reportPath}`);
      } else {
        currentJob.logs.push('[warn] Proceso OK pero no se encontró reporte live.');
      }
    } else {
      currentJob.status = 'error';
      currentJob.error = `El script terminó con código ${code}`;
      currentJob.logs.push(`[error] exit ${code}`);
    }
    void persistJobSnapshot(currentJob);
  });

  res.status(202).json({
    message: 'Señal iniciada',
    job: {
      status: currentJob.status,
      market,
      tier,
      command,
      startedAt: currentJob.startedAt,
    },
  });
});

void Promise.all([historyStore.init(), wikiStore.init()])
  .then(() => {
    app.listen(PORT, BIND_HOST, () => {
      console.log(`Flash Signals API → http://${BIND_HOST}:${PORT}`);
      console.log(`CURSOR_TRADING_ROOT = ${TRADING_ROOT}`);
      console.log(`Existe: ${fs.existsSync(TRADING_ROOT)}`);
      console.log(`Historial (hive box): ${historyStore.DB_PATH}`);
      console.log(`Wiki meta: ${wikiStore.DB_PATH}`);
    });
  })
  .catch((err) => {
    console.error('[init] No se pudo abrir SQLite local:', err);
    process.exit(1);
  });
