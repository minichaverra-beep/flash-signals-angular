/**
 * Frescura de artefactos live/: elige el PNG más reciente y detecta charts
 * o velas desactualizados para no mostrar precios viejos como actuales.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Chart más viejo que el reporte por más de esto = de otra corrida. */
const CHART_MAX_LAG_MS = 5 * 60 * 1000;

/**
 * PNG existente más reciente entre candidatos (string o array de nombres).
 * @returns {{ name: string, full: string, mtimeMs: number } | null}
 */
/** El motor, si no puede reemplazar el PNG, lo deja como `nombre_new.png`. */
function chartNameVariants(name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return [name, `${stem}_new${ext || '.png'}`];
}

function pickLatestChart(liveDir, names) {
  let best = null;
  for (const name of [names || []].flat().flatMap(chartNameVariants)) {
    const full = path.join(liveDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { name, full, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/** true si el chart es de una corrida anterior al reporte. */
function isChartStale(chartMtimeMs, reportMtimeMs) {
  if (chartMtimeMs == null || reportMtimeMs == null) return false;
  return reportMtimeMs - chartMtimeMs > CHART_MAX_LAG_MS;
}

/** Holgura: el PNG puede cerrarse un instante antes del reloj de inicio del job. */
const RUN_CHART_SLACK_MS = 15 * 1000;

/**
 * URL same-origin del PNG de esta corrida.
 * Un chart escrito durante el job no se oculta aunque el .md quede varios minutos después.
 * Un PNG anterior al job sigue oculto (chartStale) para no pintar velas viejas.
 * @param {string} market
 * @param {{ name?: string, full: string, mtimeMs: number } | null} chart
 * @param {number | null} reportMtimeMs
 * @param {number | null} [startedAtMs]
 */
function chartFields(market, chart, reportMtimeMs, startedAtMs) {
  if (!chart) {
    return { chartPath: null, chartUrl: null, chartMtime: null, chartStale: false };
  }
  const fromThisRun = Number.isFinite(startedAtMs) && chart.mtimeMs >= startedAtMs - RUN_CHART_SLACK_MS;
  const chartStale = !fromThisRun && isChartStale(chart.mtimeMs, reportMtimeMs);
  const chartUrl = `/api/signals/chart?market=${market}&v=${Math.round(chart.mtimeMs)}`;
  return {
    chartPath: chartStale ? null : chart.full,
    chartUrl: chartStale ? null : chartUrl,
    chartMtime: new Date(chart.mtimeMs).toISOString(),
    chartStale,
  };
}

/**
 * Lee «Última vela M5 **YYYY-MM-DD HH:MM UTC**» y «Datos desactualizados: …» del .md.
 * @returns {{ dataAsOf: string|null, dataStale: boolean, staleMessage: string|null }}
 */
function parseDataFreshness(md) {
  const text = String(md || '');
  const asOf = /[ÚU]ltima vela M5\s+\*\*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\*\*/i.exec(text);
  const stale = /(Datos desactualizados:[^*\n]+)/i.exec(text);
  return {
    dataAsOf: asOf ? `${asOf[1]} UTC` : null,
    dataStale: !!stale,
    staleMessage: stale ? stale[1].trim() : null,
  };
}

module.exports = {
  CHART_MAX_LAG_MS,
  RUN_CHART_SLACK_MS,
  pickLatestChart,
  isChartStale,
  chartFields,
  parseDataFreshness,
};
