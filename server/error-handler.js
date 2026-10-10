/**
 * Último middleware de Express: cualquier error que llegue aquí (body inválido/demasiado grande,
 * RangeError «Maximum call stack size exceeded», fallo de una ruta async…) responde JSON claro
 * { error, code, detail? } en vez del HTML por defecto de Express, y nunca tumba el proceso.
 */

const STACK_RE = /maximum call stack|maximum recursion depth/i;

/** @param {unknown} err */
function isRecursionError(err) {
  return Boolean(err) && typeof err === 'object' && (
    (err instanceof RangeError && STACK_RE.test(String(err.message))) ||
    STACK_RE.test(String(err.message || ''))
  );
}

/** @param {unknown} err → { status, body } */
function describeError(err) {
  const e = err && typeof err === 'object' ? err : {};
  const detail = String(e.message || err || '').slice(0, 300);
  if (isRecursionError(err)) {
    return {
      status: 500,
      body: {
        error: 'Recursión excedida al procesar la petición (datos demasiado anidados o con ciclos).',
        code: 'recursion',
        detail,
      },
    };
  }
  if (e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413) {
    return { status: 413, body: { error: 'El cuerpo de la petición es demasiado grande (máx. 8 MB).', code: 'too_large' } };
  }
  if (e.type === 'entity.parse.failed' || e instanceof SyntaxError) {
    return { status: 400, body: { error: 'JSON inválido en el cuerpo de la petición.', code: 'bad_json', detail } };
  }
  const status = Number(e.status || e.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return { status, body: { error: status < 500 ? detail || 'Petición inválida' : 'Error interno', code: 'http_error' } };
  }
  return { status: 500, body: { error: 'Error interno del servidor', code: 'internal', detail } };
}

/** Middleware de 4 argumentos (Express lo reconoce por la aridad). */
function jsonErrorHandler(err, req, res, next) {
  const { status, body } = describeError(err);
  console.error(`[api] ${req?.method || '?'} ${req?.originalUrl || req?.url || '?'} → ${status} ${body.code}:`, String(err?.message || err).slice(0, 500));
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(status).json(body);
}

module.exports = { jsonErrorHandler, describeError, isRecursionError };
