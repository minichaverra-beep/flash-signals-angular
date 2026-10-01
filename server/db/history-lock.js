/**
 * Candado efectivo de una fila del historial (reglas puras, sin I/O).
 * Bloqueada = candado manual OR (operación de un día anterior AND sin desbloqueo puntual).
 * "Hoy" = día calendario local en HISTORY_TZ (por defecto la zona del sistema), nunca medianoche UTC.
 * La fecha de la operación es created_at (la que muestra la columna Fecha de /historial).
 */

const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

function isValidTz(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Zona horaria del historial: HISTORY_TZ válida o la del sistema. */
function historyTz() {
  const fromEnv = String(process.env.HISTORY_TZ || '').trim();
  return fromEnv && isValidTz(fromEnv) ? fromEnv : SYSTEM_TZ;
}

function dayFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/**
 * Día calendario local 'YYYY-MM-DD' de un instante en la zona dada; null si la fecha es inválida.
 * @param {string|number|Date} when
 * @param {string} tz
 */
function localDayKey(when, tz) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  return dayFormatter(tz).format(d);
}

/** true si la operación es de un día local anterior a `now` (fechas inválidas no bloquean). */
function isPastDay(createdAt, now, tz) {
  const day = localDayKey(createdAt, tz);
  const today = localDayKey(now, tz);
  return day != null && today != null && day < today;
}

/**
 * Estado del candado de una fila (columnas created_at, locked, unlock_override).
 * @returns {{ locked: boolean, unlockOverride: boolean, autoLocked: boolean, effectiveLocked: boolean }}
 */
function lockState(row, now, tz) {
  const locked = Number(row?.locked) === 1;
  const unlockOverride = Number(row?.unlock_override) === 1;
  const autoLocked = isPastDay(row?.created_at, now, tz) && !unlockOverride;
  return { locked, unlockOverride, autoLocked, effectiveLocked: locked || autoLocked };
}

module.exports = {
  SYSTEM_TZ,
  historyTz,
  localDayKey,
  isPastDay,
  lockState,
};
