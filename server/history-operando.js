/**
 * Resultado «operando»: operación aceptada por MT5 y aún abierta (o LIMIT pendiente).
 * Solo se pone sobre un Resultado vacío (nunca pisa ganada/perdida/no_tomada) y respeta el candado.
 * Recalcular lo reemplaza por ganada/perdida/no_tomada cuando la operación termina.
 */
const OPERANDO = 'operando';
const OPEN_STATES = new Set(['pending', 'open']);

/** Clave mt5-sent `h<id>` → id del historial (o null). */
function historyIdFromKey(key) {
  const m = /^h(\d+)$/.exec(String(key ?? ''));
  return m ? Number(m[1]) : null;
}

/** ¿El envío fue real (no dry-run) y aceptado por MT5? */
function isRealSend(outcome, overrides = {}) {
  return outcome?.status === 'sent' && !overrides.dry_run && !outcome.result?.dryRun;
}

/**
 * Marca la fila como operando si su Resultado está vacío y no tiene candado.
 * @param {{ getById: Function, updateAnnotation: Function, LOCKED_ERROR: string }} store
 * @returns {Promise<{ marked: boolean, reason?: string, resultado?: string|null, item?: object }>}
 */
async function markOperando(store, id) {
  const row = await store.getById(id);
  if (!row) return { marked: false, reason: 'not_found' };
  if (row.effectiveLocked) return { marked: false, reason: 'locked' };
  if (row.resultado) return { marked: false, reason: 'has_resultado', resultado: row.resultado };
  const res = await store.updateAnnotation(id, { resultado: OPERANDO });
  if (res.error === store.LOCKED_ERROR) return { marked: false, reason: 'locked' };
  if (!res.ok) return { marked: false, reason: res.error || 'error' };
  return { marked: true, item: res.item };
}

/**
 * Recalcular sin cierre (annotation null): si alguna orden sigue pendiente/abierta y la fila
 * está vacía → operando; si no, la anotación tal cual.
 * @param {object|null} annotation
 * @param {object|null} row fila antes de recalcular
 * @param {Array<string|null|undefined>} states estados MT5 (original y duplicado)
 */
function recalcAnnotation(annotation, row, states = []) {
  if (annotation || !row || row.resultado) return annotation;
  return states.some((s) => OPEN_STATES.has(s)) ? { resultado: OPERANDO } : annotation;
}

module.exports = { OPERANDO, historyIdFromKey, isRealSend, markOperando, recalcAnnotation };
