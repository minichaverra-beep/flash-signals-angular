import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chartLoadErrorMessage, fetchChartBlob, loadChartImage, type ImageLike } from './chart-image.ts';

const png = (size = 64) => new Blob([new Uint8Array(size).fill(0x89)], { type: 'image/png' });

function fakeFetch(status: number, blob: Blob | null = png()): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      blob: async () => blob,
    }) as unknown as Response) as unknown as typeof fetch;
}

/** Imagen simulada: «carga» en el siguiente tick con el tamaño indicado (0 = falla). */
function imageFactory(width: number, log: string[] = [], failUrls: RegExp | null = null) {
  return (): ImageLike => {
    const img: ImageLike = {
      _src: '',
      naturalWidth: 0,
      naturalHeight: 0,
      onload: null,
      onerror: null,
      decode: async () => {},
      get src() {
        return this._src;
      },
      set src(value: string) {
        this._src = value;
        log.push(value);
        setTimeout(() => {
          if (failUrls?.test(value) || width <= 0) {
            img.onerror?.();
            return;
          }
          img.naturalWidth = width;
          img.naturalHeight = width;
          img.onload?.();
        }, 0);
      },
    } as ImageLike & { _src: string };
    return img;
  };
}

describe('chartLoadErrorMessage', () => {
  it('explica el 404 y otros códigos en español', () => {
    assert.match(chartLoadErrorMessage(404), /HTTP 404/);
    assert.match(chartLoadErrorMessage(404), /no tiene el PNG/);
    assert.equal(chartLoadErrorMessage(500), 'No se pudo cargar el gráfico: HTTP 500');
    assert.equal(chartLoadErrorMessage(null, 'timeout'), 'No se pudo cargar el gráfico: timeout');
    assert.match(chartLoadErrorMessage(null), /sin respuesta del servidor local/);
  });
});

describe('fetchChartBlob', () => {
  it('devuelve el blob same-origin con credenciales y sin caché', async () => {
    let init: RequestInit | undefined;
    const fetchFn = (async (_url: unknown, i?: RequestInit) => {
      init = i;
      return { ok: true, status: 200, blob: async () => png() } as unknown as Response;
    }) as unknown as typeof fetch;
    const out = await fetchChartBlob('/api/signals/chart?market=btc', fetchFn);
    assert.ok(out.blob);
    assert.equal(out.error, null);
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
  });

  it('404 → motivo legible, sin lanzar', async () => {
    const out = await fetchChartBlob('/api/signals/chart?market=btc', fakeFetch(404));
    assert.equal(out.blob, null);
    assert.match(out.error ?? '', /HTTP 404/);
  });

  it('respuesta vacía o no imagen → error', async () => {
    const empty = await fetchChartBlob('/x', fakeFetch(200, png(4)));
    assert.match(empty.error ?? '', /vacío/);
    const json = await fetchChartBlob('/x', fakeFetch(200, new Blob(['{"error":1}'.repeat(10)], { type: 'application/json' })));
    assert.match(json.error ?? '', /no es una imagen/);
  });

  it('fallo de red → motivo con el mensaje', async () => {
    const fetchFn = (async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof fetch;
    const out = await fetchChartBlob('/x', fetchFn);
    assert.equal(out.blob, null);
    assert.match(out.error ?? '', /Failed to fetch/);
  });
});

describe('loadChartImage', () => {
  it('fetch → blob → object URL → imagen decodificada; revoke libera la URL', async () => {
    const log: string[] = [];
    const revoked: string[] = [];
    const out = await loadChartImage('/api/signals/chart?market=btc&v=1', {
      fetchFn: fakeFetch(200),
      createImage: imageFactory(2800, log),
      createObjectUrl: () => 'blob:fake-1',
      revokeObjectUrl: (u) => revoked.push(u),
    });
    assert.ok(out.img, 'imagen cargada');
    assert.equal(out.error, null);
    assert.deepEqual(log, ['blob:fake-1']);
    out.revoke();
    assert.deepEqual(revoked, ['blob:fake-1']);
  });

  it('404 del servidor → img null con el motivo (no reintenta la URL directa)', async () => {
    const log: string[] = [];
    const out = await loadChartImage('/api/signals/chart?market=btc', {
      fetchFn: fakeFetch(404),
      createImage: imageFactory(100, log),
      createObjectUrl: () => 'blob:never',
      revokeObjectUrl: () => {},
    });
    assert.equal(out.img, null);
    assert.match(out.error ?? '', /HTTP 404/);
    assert.deepEqual(log, []);
  });

  it('si el blob no decodifica, prueba la URL directa antes de rendirse', async () => {
    const log: string[] = [];
    const out = await loadChartImage('/api/signals/chart?market=btc', {
      fetchFn: fakeFetch(200),
      createImage: imageFactory(640, log, /^blob:/),
      createObjectUrl: () => 'blob:bad',
      revokeObjectUrl: () => {},
    });
    assert.ok(out.img);
    assert.deepEqual(log, ['blob:bad', '/api/signals/chart?market=btc']);
  });

  it('imagen que nunca carga → error de decodificación (no se queda colgado)', async () => {
    const out = await loadChartImage('/api/signals/chart?market=btc', {
      fetchFn: fakeFetch(200),
      createImage: imageFactory(0),
      createObjectUrl: () => 'blob:zero',
      revokeObjectUrl: () => {},
      timeoutMs: 2000,
    });
    assert.equal(out.img, null);
    assert.match(out.error ?? '', /No se pudo cargar el gráfico/);
  });
});
