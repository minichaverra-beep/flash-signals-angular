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
function pickLatestChart(liveDir, names) {
  let best = null;
  for (const name of [names || []].flat()) {
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
  pickLatestChart,
  isChartStale,
  parseDataFreshness,
};
