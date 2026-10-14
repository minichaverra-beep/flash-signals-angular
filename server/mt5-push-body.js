/**
 * Validación del body de POST /api/mt5/push (sin dependencias de Express, para testearla aislada).
 */
const { parseStyle } = require('./mt5-style');

/** dryRun / allowMultiple / volume / riskPct / style del body → { overrides, style } | { error }. */
function parsePushOverrides(body = {}) {
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
  const { style, error } = parseStyle(body.style);
  if (error) return { error };
  return { overrides, style };
}

module.exports = { parsePushOverrides };
