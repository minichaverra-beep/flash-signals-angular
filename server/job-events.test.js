/**
 * Tests del canal SSE del job (snapshot al conectar + broadcast + limpieza).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { JOB_EVENTS, formatEvent, createJobEvents } = require('./job-events');

function fakeClient() {
  const req = new EventEmitter();
  const res = {
    headers: {},
    chunks: [],
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    flushHeaders() {},
    write(chunk) {
      this.chunks.push(chunk);
    },
    end() {
      this.ended = true;
    },
  };
  return { req, res };
}

/** Parsea los eventos SSE escritos en el fake response. */
function parseEvents(chunks) {
  return chunks
    .join('')
    .split('\n\n')
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block);
      const data = /^data: (.+)$/m.exec(block);
      return event ? { event: event[1], data: JSON.parse(data[1]) } : null;
    })
    .filter(Boolean);
}

describe('job-events (SSE)', () => {
  it('formatEvent serializa event + data JSON', () => {
    assert.equal(
      formatEvent('job:started', { id: 'a', status: 'running' }),
      'event: job:started\ndata: {"id":"a","status":"running"}\n\n'
    );
  });

  it('attach configura headers SSE y envía snapshot inmediato', () => {
    const hub = createJobEvents({ heartbeatMs: 0 });
    const { req, res } = fakeClient();
    hub.attach(req, res, { id: 'j1', status: 'running', logs: [] });

    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.headers['cache-control'], /no-cache/);
    assert.ok(res.chunks[0].startsWith('retry: '));
    const events = parseEvents(res.chunks);
    assert.deepEqual(events, [
      { event: JOB_EVENTS.snapshot, data: { id: 'j1', status: 'running', logs: [] } },
    ]);
    assert.equal(hub.clientCount(), 1);
    hub.close();
  });

  it('broadcast llega a todos los clientes conectados', () => {
    const hub = createJobEvents({ heartbeatMs: 0 });
    const a = fakeClient();
    const b = fakeClient();
    hub.attach(a.req, a.res, { status: 'idle', logs: [] });
    hub.attach(b.req, b.res, { status: 'idle', logs: [] });

    hub.broadcast(JOB_EVENTS.progress, { id: 'j1', lines: ['[out] hola'] });

    for (const client of [a, b]) {
      const last = parseEvents(client.res.chunks).at(-1);
      assert.deepEqual(last, {
        event: JOB_EVENTS.progress,
        data: { id: 'j1', lines: ['[out] hola'] },
      });
    }
    hub.close();
  });

  it('elimina el cliente al cerrar la conexión', () => {
    const hub = createJobEvents({ heartbeatMs: 0 });
    const { req, res } = fakeClient();
    hub.attach(req, res, { status: 'idle', logs: [] });
    req.emit('close');
    assert.equal(hub.clientCount(), 0);

    hub.broadcast(JOB_EVENTS.finished, { id: 'j1', status: 'done' });
    assert.equal(parseEvents(res.chunks).length, 1);
  });

  it('emite ping periódico como evento (detección de caída en el cliente)', async () => {
    const hub = createJobEvents({ heartbeatMs: 10 });
    const { req, res } = fakeClient();
    hub.attach(req, res, { status: 'idle', logs: [] });
    await new Promise((r) => setTimeout(r, 35));
    const pings = parseEvents(res.chunks).filter((e) => e.event === JOB_EVENTS.ping);
    assert.ok(pings.length >= 1);
    assert.equal(typeof pings[0].data.t, 'number');
    hub.close();
  });

  it('un cliente que falla al escribir se descarta sin afectar al resto', () => {
    const hub = createJobEvents({ heartbeatMs: 0 });
    const ok = fakeClient();
    const broken = fakeClient();
    hub.attach(ok.req, ok.res, { status: 'idle', logs: [] });
    hub.attach(broken.req, broken.res, { status: 'idle', logs: [] });
    broken.res.write = () => {
      throw new Error('socket cerrado');
    };

    hub.broadcast(JOB_EVENTS.failed, { id: 'j1', status: 'error' });

    assert.equal(hub.clientCount(), 1);
    assert.equal(parseEvents(ok.res.chunks).at(-1).event, JOB_EVENTS.failed);
    hub.close();
    assert.ok(ok.res.ended);
  });
});
