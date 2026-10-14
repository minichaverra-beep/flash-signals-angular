/**
 * Probabilidad mínima para Run operation (reglas puras, sin I/O).
 * Probabilidad = scoreCombined de la fila del historial (0–100).
 */

const DEFAULT_MIN_PROBABILITY_PCT = 45;

/** Mínimo efectivo del perfil; 0 = sin mínimo. */
function minProbabilityPct(settings = {}) {
  const n = Number(settings.minProbabilityPct);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_MIN_PROBABILITY_PCT;
}

/** scoreCombined de la fila (o de su summary) como número; null si no hay. */
function rowProbability(row) {
  const raw = row?.scoreCombined ?? row?.summary?.scoreCombined;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function formatPct(n) {
  return `${Math.round(n * 10) / 10}%`;
}

/**
 * → { blocked, message, warning, probability, min }.
 * Bloquea si la probabilidad es un número < mínimo; sin probabilidad se permite con aviso.
 */
function probabilityRejection(row, settings) {
  const min = minProbabilityPct(settings);
  const probability = rowProbability(row);
  if (min <= 0) return { blocked: false, message: null, warning: null, probability, min };
  if (probability == null) {
    return {
      blocked: false,
      message: null,
      warning: `Probabilidad desconocida: no se pudo comprobar el mínimo ${formatPct(min)}`,
      probability,
      min,
    };
  }
  if (probability < min) {
    return {
      blocked: true,
      message: `Probabilidad ${formatPct(probability)} < mínimo ${formatPct(min)}: Run bloqueado`,
      warning: null,
      probability,
      min,
    };
  }
  return { blocked: false, message: null, warning: null, probability, min };
}

module.exports = { DEFAULT_MIN_PROBABILITY_PCT, minProbabilityPct, rowProbability, probabilityRejection };
