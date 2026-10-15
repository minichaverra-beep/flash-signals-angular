/**
 * Resultados reales → Cursor Trading (live/outcomes/<asset>_outcomes.jsonl, schemaVersion 1).
 * Append-only e idempotente por historyId: si resultado/$PnL/ticket no cambiaron no se escribe;
 * si cambiaron se añade otro registro con revision+1 y supersedes = revision anterior
 * (el vigente es el de mayor revision). Nunca para 'operando' / vacío ni filas bloqueadas.
 * Cualquier fallo (sin CURSOR_TRADING_ROOT, sin permisos) solo avisa: no rompe la acción del usuario.
 */
const fs = require('node:fs');
const path = require('node:path');

const OUTCOME_SCHEMA_VERSION = 1;
const FINAL_RESULTS = new Set(['ganada', 'perdida', 'no_tomada']);
const OUTCOME_MARKETS = new Set(['btc', 'us30', 'xauusd']);
const OUTCOME_SOURCES = new Set(['manual', 'mt5_recalc', 'auto_capture']);

function outcomesFile(tradingRoot, market) {
  return path.join(tradingRoot, 'live', 'outcomes', `${market}_outcomes.jsonl`);
}

const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function mt5Block(row, sent, profile) {
  const real = row.real || {};
  const ticket = num(real.ticket) ?? num(sent?.order);
  if (ticket == null) return null;
  return {
    ticket,
    entry: num(real.entry) ?? num(sent?.price),
    sl: num(real.sl) ?? num(sent?.sl),
    tp: num(sent?.tp),
    exit: num(real.exit) ?? num(sent?.closePrice),
    volume: num(sent?.volume),
    profile: profile ?? null,
  };
}

function duplicateBlock(sent) {
  const dup = sent?.duplicate;
  if (!dup?.order) return null;
  return {
    ticket: num(dup.order),
    volume: num(dup.volume),
    state: dup.state ?? null,
    profit: num(dup.profit),
    closeReason: dup.closeReason ?? null,
  };
}

/**
 * Registro schema 1 a partir del detalle de la fila del historial (getById).
 * @param {object} row detalle (summary, resultado, pnlUsd, real, market, finishedAt…)
 * @param {{ source: string, sent?: object|null, profile?: string|null, now?: Date }} opts
 */
function buildOutcomeRecord(row, { source, sent = null, profile = null, now = new Date() }) {
  const summary = row.summary || {};
  const engine = summary.engine || {};
  const plan = summary.planDetails || {};
  const prob = engine.probability || {};
  return {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    recordedUtc: now.toISOString(),
    historyId: row.id,
    revision: 1,
    supersedes: null,
    signalId: engine.signalId ?? null,
    asset: String(row.market || '').toUpperCase(),
    generatedUtc: engine.generatedUtc ?? row.finishedAt ?? row.createdAt ?? null,
    direction: engine.direction ?? null,
    plan: { entry: num(plan.entry), sl: num(plan.sl), tp: num(plan.tp) },
    prediction: {
      probabilityPct: num(prob.pct) ?? num(summary.scoreCombined),
      ci: Array.isArray(prob.ci) ? prob.ci.map(num) : null,
      evR: num(prob.evR),
      calibrated: typeof prob.calibrated === 'boolean' ? prob.calibrated : null,
      mlPct: num(engine.ml?.pct) ?? num(summary.mlPct),
      neuralPct: num(engine.neural?.effectivePct) ?? num(engine.neural?.pct),
      rulesPct: num(engine.rules?.e1?.pct) ?? num(summary.rulesPct),
      fusionScore: num(engine.fusion?.score) ?? num(summary.scoreCombined),
      verdict: summary.verdict ?? engine.verdict ?? null,
    },
    outcome: {
      resultado: row.resultado,
      pnlUsd: num(row.pnlUsd),
      pnlSource: row.pnlSource ?? null,
      closeReason: sent?.closeReason ?? null,
      mt5: mt5Block(row, sent, profile),
      duplicate: duplicateBlock(sent),
    },
    source,
  };
}

/** Lo que define «el mismo resultado» (si no cambia, no se escribe otra línea). */
function fingerprint(rec) {
  const o = rec.outcome || {};
  return JSON.stringify([o.resultado, o.pnlUsd, o.mt5?.ticket ?? null, o.duplicate?.ticket ?? null]);
}

/** Último registro de la fila en el archivo (mayor revision). */
function lastRecordFor(file, historyId, fsImpl = fs) {
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.historyId !== historyId) continue;
    if (!last || Number(rec.revision || 0) >= Number(last.revision || 0)) last = rec;
  }
  return last;
}

/**
 * Añade el resultado de la fila al JSONL del motor si es final y cambió.
 * @returns {{ written: boolean, reason: string, file?: string, record?: object }}
 */
function recordOutcome({ tradingRoot, row, source, sent = null, profile = null, fsImpl = fs, logger = console, now }) {
  if (!row || !Number.isInteger(row.id)) return { written: false, reason: 'no_row' };
  if (!FINAL_RESULTS.has(row.resultado)) return { written: false, reason: 'not_final' };
  if (row.effectiveLocked) return { written: false, reason: 'locked' };
  if (!OUTCOME_MARKETS.has(row.market)) return { written: false, reason: 'market' };
  if (!OUTCOME_SOURCES.has(source)) return { written: false, reason: 'source' };
  if (!tradingRoot || !fsImpl.existsSync(tradingRoot)) {
    logger.warn?.('[engine-outcomes] CURSOR_TRADING_ROOT no accesible: resultado no enviado al motor');
    return { written: false, reason: 'no_root' };
  }
  const file = outcomesFile(tradingRoot, row.market);
  try {
    const record = buildOutcomeRecord(row, { source, sent, profile, now });
    const prev = lastRecordFor(file, row.id, fsImpl);
    if (prev && fingerprint(prev) === fingerprint(record)) return { written: false, reason: 'unchanged', file };
    if (prev) {
      record.revision = Number(prev.revision || 0) + 1;
      record.supersedes = Number(prev.revision || 0);
    }
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return { written: true, reason: 'ok', file, record };
  } catch (err) {
    logger.warn?.(`[engine-outcomes] No se pudo escribir ${file}: ${err.message}`);
    return { written: false, reason: 'io_error', file };
  }
}

module.exports = {
  OUTCOME_SCHEMA_VERSION,
  FINAL_RESULTS,
  outcomesFile,
  buildOutcomeRecord,
  fingerprint,
  lastRecordFor,
  recordOutcome,
};
