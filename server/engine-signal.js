/**
 * JSON estructurado del motor (Cursor Trading live/<asset>_m5_high_signal.json, schemaVersion 1).
 * Se lee junto al .md del reporte: prevalece en los campos de análisis y se guarda crudo en
 * summary.engine. Los campos que usa el Run operation de MT5 (planDetails entry/sl/tp/rr/risk,
 * scoreCombined, verdict) siguen saliendo del .md cuando existe, para no cambiar el envío de órdenes.
 * JSON ausente / inválido / de otra versión / anterior al .md → summary solo del markdown.
 */
const fs = require('node:fs');

const ENGINE_SCHEMA_VERSION = 1;
/** El .json se escribe justo después del .md; más antiguo que esto = de una corrida anterior. */
const ENGINE_MAX_LAG_MS = 30_000;

/** live/btc_m5_high_signal.md → live/btc_m5_high_signal.json (solo reportes High). */
function engineJsonPath(reportPath) {
  if (!reportPath || !/_high_signal\.md$/i.test(String(reportPath))) return null;
  return String(reportPath).replace(/\.md$/i, '.json');
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Valida forma mínima del schema 1 → motivo del rechazo o null si es válido. */
function engineRejection(engine) {
  if (!isPlainObject(engine)) return 'invalid';
  if (engine.schemaVersion !== ENGINE_SCHEMA_VERSION) return 'schema';
  if (typeof engine.asset !== 'string' || !engine.asset) return 'invalid';
  return null;
}

/**
 * Lee y valida el JSON del motor junto al reporte.
 * @returns {{ engine: object|null, reason: 'ok'|'no_path'|'missing'|'invalid'|'schema'|'stale' }}
 */
function loadEngineJson(reportPath, reportMtimeMs, fsImpl = fs) {
  const file = engineJsonPath(reportPath);
  if (!file) return { engine: null, reason: 'no_path' };
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch {
    return { engine: null, reason: 'missing' };
  }
  if (Number.isFinite(reportMtimeMs) && stat.mtimeMs < reportMtimeMs - ENGINE_MAX_LAG_MS) {
    return { engine: null, reason: 'stale' };
  }
  let engine;
  try {
    engine = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return { engine: null, reason: 'invalid' };
  }
  const rejection = engineRejection(engine);
  return rejection ? { engine: null, reason: rejection } : { engine, reason: 'ok' };
}

const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => (v == null || v === '' ? null : String(v));

/** 2 → "1:2"; 1.75 → "1:1.8" (mismo formato que el .md). */
function rrText(rr) {
  const n = num(rr);
  if (n == null) return null;
  return Math.abs(n - Math.round(n)) < 0.05 ? `1:${Math.round(n)}` : `1:${n.toFixed(1)}`;
}

/** Nivel de precio como texto con decimales acotados (planDetails guarda strings). */
function levelText(v) {
  const n = num(v);
  if (n == null) return null;
  return String(Math.round(n * 100) / 100);
}

function planFromEngine(plan = {}) {
  return {
    entry: levelText(plan.entry),
    sl: levelText(plan.sl),
    tp: levelText(plan.tp),
    rr: rrText(plan.rr),
    risk: levelText(plan.risk),
    trigger: str(plan.trigger),
    invalidation: str(plan.invalidation),
    confirmation: str(plan.confirmation),
  };
}

const LAYER_LABELS = [
  ['rules', 'Rules E1'],
  ['extended', 'Rules extendidas'],
  ['crt', 'CRT coherence'],
  ['neural', 'Neural galería'],
  ['ml', 'ML tabular'],
  ['e2', 'E2 turtle'],
];

function chartScoresFromEngine(engine) {
  const layers = engine.fusion?.layers || {};
  const out = [];
  for (const [key, label] of LAYER_LABELS) {
    const v = num(layers[key]);
    if (v != null) out.push({ label, value: Math.max(0, Math.min(100, v)) });
  }
  const prob = num(engine.probability?.pct);
  if (prob != null) out.push({ label: 'Probabilidad de éxito', value: prob });
  return out.slice(0, 8);
}

function checklistFromEngine(items) {
  return (Array.isArray(items) ? items : [])
    .map((i) => ({ label: str(i?.label) || '', ok: typeof i?.ok === 'boolean' ? i.ok : null, note: str(i?.note) || '' }))
    .filter((i) => i.label)
    .slice(0, 10);
}

function rulesReviewFromEngine(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      label: str(r?.label) || '',
      grade: str(r?.grade) || '',
      value: str(r?.value) || '',
      impact: str(r?.impact) || '',
      winrate: str(r?.wr) || '',
      type: str(r?.type) || '',
    }))
    .filter((r) => r.label)
    .slice(0, 12);
}

/** Campos de análisis que el JSON aporta (sin plan de órdenes). */
function analysisFromEngine(engine) {
  const vol = engine.zentinel?.volume || {};
  const fresh = engine.dataFreshness || {};
  return {
    bias: str(engine.bias),
    setup: str(engine.setup),
    winrate: str(engine.winrate?.value),
    rulesPct: num(engine.rules?.e1?.pct),
    mlPct: num(engine.ml?.pct),
    confluencePct: num(engine.confluence?.pct),
    confluenceLabel: str(engine.confluence?.label),
    scoreExtended: num(engine.rules?.extended?.pct),
    probCalibrated: typeof engine.probability?.calibrated === 'boolean' ? engine.probability.calibrated : null,
    dataStale: typeof fresh.stale === 'boolean' ? fresh.stale : null,
    staleMessage: fresh.stale ? str(fresh.message) : null,
    dataAsOf: fresh.lastCandleUtc ? `${fresh.lastCandleUtc} UTC` : null,
    volBand: str(vol.band),
    volRatio: num(vol.ratio),
    volPreset: str(vol.preset_name) || str(engine.zentinel?.presets?.fvg_volume_preset),
    killzone: str(engine.zentinel?.killzone),
    kzOn: typeof engine.zentinel?.killzoneOn === 'boolean' ? engine.zentinel.killzoneOn : null,
    redFlags: Array.isArray(engine.redFlags) ? engine.redFlags.map(String).slice(0, 10) : [],
  };
}

/** summary completo solo desde el JSON (sin .md). */
function summaryFromEngine(engine, market, tier) {
  const a = analysisFromEngine(engine);
  const plan = planFromEngine(engine.plan);
  const prob = num(engine.probability?.pct);
  return {
    market,
    tier,
    dataAsOf: a.dataAsOf,
    dataStale: a.dataStale ?? false,
    staleMessage: a.staleMessage,
    verdict: str(engine.verdict),
    plan: null,
    twoM5: null,
    redFlags: a.redFlags,
    zentinel: {
      killzone: a.killzone,
      watchtowerKz: null,
      volBand: a.volBand,
      volRatio: a.volRatio,
      preset: a.volPreset,
      kzOn: a.kzOn,
    },
    price: engine.price != null ? String(engine.price) : null,
    entryOptima: levelText(engine.plan?.optimalEntry) ?? plan.entry,
    bias: a.bias,
    setup: a.setup,
    impulso: null,
    winrate: a.winrate,
    rulesPct: a.rulesPct,
    mlPct: a.mlPct,
    confluencePct: a.confluencePct,
    confluenceLabel: a.confluenceLabel,
    scoreExtended: a.scoreExtended,
    scoreCombined: num(engine.fusion?.score) ?? prob,
    planDetails: plan,
    checklist2M5: [],
    checklistE1: checklistFromEngine(engine.checklists?.e1),
    rulesReview: rulesReviewFromEngine(engine.checklists?.rulesReview),
    probCalibrated: a.probCalibrated ?? false,
    scorecard: [],
    chartScores: chartScoresFromEngine(engine),
    volume: { band: a.volBand, ratio: a.volRatio, preset: a.volPreset, thresholds: null },
    engine,
    engineSource: 'json',
  };
}

const pick = (engineVal, mdVal) => (engineVal ?? mdVal ?? null);

/**
 * summary del .md + JSON del motor. El JSON prevalece en análisis; el plan de órdenes y
 * scoreCombined/verdict del .md se conservan (solo se rellenan textos del plan que falten).
 */
function mergeEngineSummary(mdSummary, engine, market, tier) {
  if (!engine) return mdSummary ? { ...mdSummary, engineSource: 'markdown' } : null;
  if (!mdSummary) return summaryFromEngine(engine, market, tier);
  const a = analysisFromEngine(engine);
  const md = mdSummary;
  const mdPlan = md.planDetails || {};
  const enginePlan = planFromEngine(engine.plan);
  return {
    ...md,
    bias: pick(a.bias, md.bias),
    setup: pick(a.setup, md.setup),
    winrate: pick(a.winrate, md.winrate),
    rulesPct: pick(a.rulesPct, md.rulesPct),
    mlPct: pick(a.mlPct, md.mlPct),
    confluencePct: pick(a.confluencePct, md.confluencePct),
    confluenceLabel: pick(a.confluenceLabel, md.confluenceLabel),
    scoreExtended: pick(a.scoreExtended, md.scoreExtended),
    probCalibrated: pick(a.probCalibrated, md.probCalibrated),
    dataStale: pick(a.dataStale, md.dataStale),
    staleMessage: a.dataStale == null ? md.staleMessage ?? null : a.staleMessage,
    dataAsOf: pick(a.dataAsOf, md.dataAsOf),
    redFlags: a.redFlags.length ? a.redFlags : md.redFlags || [],
    verdict: md.verdict ?? str(engine.verdict),
    planDetails: {
      ...mdPlan,
      trigger: mdPlan.trigger ?? enginePlan.trigger,
      invalidation: mdPlan.invalidation ?? enginePlan.invalidation,
      confirmation: mdPlan.confirmation ?? enginePlan.confirmation,
    },
    checklistE1: md.checklistE1?.length ? md.checklistE1 : checklistFromEngine(engine.checklists?.e1),
    rulesReview: md.rulesReview?.length ? md.rulesReview : rulesReviewFromEngine(engine.checklists?.rulesReview),
    chartScores: md.chartScores?.length ? md.chartScores : chartScoresFromEngine(engine),
    volume: {
      ...md.volume,
      band: pick(a.volBand, md.volume?.band),
      ratio: pick(a.volRatio, md.volume?.ratio),
      preset: pick(md.volume?.preset, a.volPreset),
    },
    zentinel: {
      ...md.zentinel,
      killzone: pick(a.killzone, md.zentinel?.killzone),
      kzOn: pick(a.kzOn, md.zentinel?.kzOn),
      volBand: pick(a.volBand, md.zentinel?.volBand),
      volRatio: pick(a.volRatio, md.zentinel?.volRatio),
    },
    engine,
    engineSource: 'json',
  };
}

module.exports = {
  ENGINE_SCHEMA_VERSION,
  ENGINE_MAX_LAG_MS,
  engineJsonPath,
  engineRejection,
  loadEngineJson,
  summaryFromEngine,
  mergeEngineSummary,
  rrText,
};
