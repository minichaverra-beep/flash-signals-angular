/**
 * Candado efectivo de una fila (misma regla que server/db/history-lock.js).
 * Bloqueada = candado manual OR (operación de un día local anterior AND sin desbloqueo puntual).
 * "Hoy" = día calendario en la zona del API (lockTz), sobre createdAt (columna Fecha).
 */

export interface LockableRow {
  createdAt?: string | null;
  locked?: boolean;
  unlockOverride?: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz || '';
  let f = formatters.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit' };
    try {
      f = new Intl.DateTimeFormat('en-CA', tz ? { ...opts, timeZone: tz } : opts);
    } catch {
      f = new Intl.DateTimeFormat('en-CA', opts);
    }
    formatters.set(key, f);
  }
  return f;
}

/** Día local 'YYYY-MM-DD' en la zona dada (o la del navegador); null si la fecha es inválida. */
export function localDayKey(when: string | number | Date, tz?: string): string | null {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  return dayFormatter(tz).format(d);
}

/** true si la operación es de un día local anterior a `nowMs` (fechas inválidas no bloquean). */
export function isPastDay(createdAt: string | null | undefined, nowMs: number, tz?: string): boolean {
  if (!createdAt) return false;
  const day = localDayKey(createdAt, tz);
  const today = localDayKey(nowMs, tz);
  return day != null && today != null && day < today;
}

/** Bloqueada por fecha: día anterior sin desbloqueo puntual. */
export function isAutoLocked(row: LockableRow, nowMs: number, tz?: string): boolean {
  return isPastDay(row.createdAt, nowMs, tz) && !row.unlockOverride;
}

export function isEffectivelyLocked(row: LockableRow, nowMs: number, tz?: string): boolean {
  return !!row.locked || isAutoLocked(row, nowMs, tz);
}
