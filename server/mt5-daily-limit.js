/**
 * Límite de operaciones por día (reglas puras, sin I/O).
 * Operación de hoy = señal enviada de verdad a MT5 hoy con el perfil (mt5-sent, sin dry-run ni duplicados)
 * o señal creada hoy con resultado ganada/perdida (tomada a mano, p. ej. desde el móvil); cada señal cuenta una vez.
 * "Hoy" = día calendario local en HISTORY_TZ (como el candado del historial).
 */
const { localDayKey } = require('./db/history-lock');

const TAKEN_RESULTS = new Set(['ganada', 'perdida']);

/** Límite efectivo del perfil; 0 = sin límite. */
function effectiveTradeLimit(settings = {}) {
  const max = Number(settings.maxTradesPerDay);
  return settings.dailyTradeLimitEnabled !== false && Number.isInteger(max) && max > 0 ? max : 0;
}

/**
 * @param {{ sent?: Record<string, { at?: string }>, taken?: { id: number, createdAt: string, resultado?: string|null }[], now?: Date, tz: string }} input
 */
function countTradesToday({ sent = {}, taken = [], now = new Date(), tz }) {
  const today = localDayKey(now, tz);
  const keys = new Set();
  for (const [key, entry] of Object.entries(sent)) {
    if (localDayKey(entry?.at, tz) === today) keys.add(key);
  }
  for (const row of taken) {
    if (TAKEN_RESULTS.has(row?.resultado) && localDayKey(row.createdAt, tz) === today) keys.add(`h${row.id}`);
  }
  return keys.size;
}

function limitReachedMessage(count, limit) {
  return `Límite diario de operaciones alcanzado (${count}/${limit})`;
}

/** → { enabled, limit, count, remaining, reached, day, tz, message } */
function dailyLimitStatus(settings, count, { now = new Date(), tz }) {
  const limit = effectiveTradeLimit(settings);
  const enabled = limit > 0;
  const reached = enabled && count >= limit;
  return {
    enabled,
    limit: enabled ? limit : null,
    count,
    remaining: enabled ? Math.max(0, limit - count) : null,
    reached,
    day: localDayKey(now, tz),
    tz,
    message: reached ? limitReachedMessage(count, limit) : null,
  };
}

module.exports = { TAKEN_RESULTS, effectiveTradeLimit, countTradesToday, dailyLimitStatus, limitReachedMessage };
