/**
 * ¿Mostrar el botón «⚙ Parámetros» de una operación enviada a MT5?
 * El modal enseña distancias vivas a TP/SL, así que solo tiene sentido mientras alguna pata
 * (original o duplicada) siga viva y la fila no tenga resultado ni esté bloqueada.
 */
import type { HistoryResultado, Mt5SentEntry } from '../../services/signals-api.service';

const FINISHED_STATES: ReadonlySet<NonNullable<Mt5SentEntry['state']>> = new Set(['closed', 'canceled', 'expired']);

/** Pata terminada en MT5 (cerrada, cancelada o expirada). Sin estado leído aún cuenta como viva. */
export function isSentLegFinished(leg: Pick<Mt5SentEntry, 'state'> | null | undefined): boolean {
  return !!leg?.state && FINISHED_STATES.has(leg.state);
}

export function canShowParams(
  resultado: HistoryResultado | null | undefined,
  sent: Pick<Mt5SentEntry, 'state' | 'duplicate'> | null | undefined,
  locked: boolean,
): boolean {
  if (!sent || locked) return false;
  if (resultado === 'ganada' || resultado === 'perdida') return false;
  const originalAlive = !isSentLegFinished(sent);
  const duplicateAlive = !!sent.duplicate && !isSentLegFinished(sent.duplicate);
  return originalAlive || duplicateAlive;
}
