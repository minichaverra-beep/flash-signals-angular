/**
 * Canal SSE del job en curso (señal E1 / MACD-quant).
 * El job vive en el servidor: tras F5 o cambio de ruta el cliente se reconecta
 * y recibe `snapshot` con el estado actual, luego job:progress / job:finished / job:failed.
 */
/**
 * Latido como evento real (no comentario SSE): el proxy de `ng serve` no cierra el
 * stream si la API cae, así que el cliente detecta la caída por ausencia de pings.
 */
const HEARTBEAT_MS = 15000;
const RETRY_MS = 3000;

const JOB_EVENTS = Object.freeze({
  ping: 'ping',
  snapshot: 'snapshot',
  started: 'job:started',
  progress: 'job:progress',
  finished: 'job:finished',
  failed: 'job:failed',
});

/** Serializa un evento SSE (data JSON en una sola línea). */
function formatEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

/**
 * @param {{ heartbeatMs?: number }} [opts]
 */
function createJobEvents({ heartbeatMs = HEARTBEAT_MS } = {}) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();
  let heartbeat = null;

  function write(res, chunk) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function ensureHeartbeat() {
    if (heartbeat || heartbeatMs <= 0) return;
    heartbeat = setInterval(() => broadcast(JOB_EVENTS.ping, { t: Date.now() }), heartbeatMs);
    heartbeat.unref?.();
  }

  function broadcast(event, data) {
    const chunk = formatEvent(event, data);
    for (const res of clients) write(res, chunk);
  }

  /** Abre el stream SSE y envía el snapshot inmediato. */
  function attach(req, res, snapshot) {
    res.status?.(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    clients.add(res);
    write(res, `retry: ${RETRY_MS}\n\n`);
    write(res, formatEvent(JOB_EVENTS.snapshot, snapshot));
    ensureHeartbeat();
    req.on('close', () => {
      clients.delete(res);
      if (!clients.size) stopHeartbeat();
    });
  }

  return {
    attach,
    broadcast,
    clientCount: () => clients.size,
    close() {
      stopHeartbeat();
      for (const res of clients) {
        try {
          res.end();
        } catch {
          // cliente ya cerrado
        }
      }
      clients.clear();
    },
  };
}

module.exports = { JOB_EVENTS, formatEvent, createJobEvents };
