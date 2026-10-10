import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_BRIDGE_MESSAGE,
  blobToBase64,
  describeKind,
  extensionForMime,
  getNativeDownloader,
  isWebViewUa,
  sanitizeFilename,
  saveBlob,
  saveFromUrl,
  suggestImageFilename,
  type NativeDownloader,
} from './file-download.ts';

const WEBVIEW_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
const CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });

describe('detección del puente nativo', () => {
  it('getNativeDownloader exige saveBase64', () => {
    assert.equal(getNativeDownloader({}), null);
    assert.equal(getNativeDownloader(undefined), null);
    assert.equal(getNativeDownloader({ AndroidDownloader: {} }), null);
    const b: NativeDownloader = { saveBase64: () => true };
    assert.equal(getNativeDownloader({ AndroidDownloader: b }), b);
  });

  it('isWebViewUa distingue el WebView del APK de Chrome', () => {
    assert.equal(isWebViewUa(WEBVIEW_UA), true);
    assert.equal(isWebViewUa(CHROME_UA), false);
    assert.equal(isWebViewUa(undefined), false);
  });
});

describe('nombres de archivo', () => {
  it('sanitizeFilename quita rutas y caracteres reservados', () => {
    assert.equal(sanitizeFilename('../../x/y.png'), 'y.png');
    assert.equal(sanitizeFilename('a:b*c?.png'), 'abc.png');
    assert.equal(sanitizeFilename('', 'z.png'), 'z.png');
    assert.equal(sanitizeFilename(null), 'descarga');
  });

  it('extensionForMime', () => {
    assert.equal(extensionForMime('image/png'), '.png');
    assert.equal(extensionForMime('image/jpeg; charset=x'), '.jpg');
    assert.equal(extensionForMime('foo/bar'), '');
  });

  it('suggestImageFilename reconoce las URLs de la API', () => {
    assert.equal(suggestImageFilename('/api/history/12/result-image?v=3'), 'resultado-12.png');
    assert.equal(suggestImageFilename('/api/history/12/result-image', 'image/jpeg'), 'resultado-12.jpg');
    assert.equal(suggestImageFilename('/api/signals/chart?market=BTC&v=99'), 'grafico-btc.png');
    assert.equal(suggestImageFilename('/api/signals/chart'), 'grafico-btc.png');
    assert.equal(suggestImageFilename('/api/signals/macd-chart?market=eth&t=1'), 'macd-h4-eth.png');
    assert.equal(suggestImageFilename('/api/signals/macd-quant/history/5/chart'), 'macd-quant-5.png');
    assert.equal(suggestImageFilename('http://127.0.0.1:3847/assets/foto%20uno.webp'), 'foto uno.webp');
    assert.equal(
      suggestImageFilename('/api/x/raw?path=1', 'image/png', new Date('2026-10-10T15:30:00Z')),
      'imagen-202610101530.png',
    );
  });

  it('describeKind', () => {
    assert.equal(describeKind('a.png'), 'Imagen');
    assert.equal(describeKind('a.pdf'), 'PDF');
    assert.equal(describeKind('a.xlsx'), 'Excel');
    assert.equal(describeKind('a.bin', 'application/octet-stream'), 'Archivo');
  });
});

describe('blobToBase64', () => {
  it('codifica sin prefijo data:', async () => {
    assert.equal(await blobToBase64(png()), 'iVBORw==');
  });
});

describe('saveBlob', () => {
  it('APK: entrega base64 al puente y avisa «guardada en Descargas»', async () => {
    const calls: Array<[string, string, string]> = [];
    const bridge: NativeDownloader = {
      saveBase64: (n, m, b) => {
        calls.push([n, m, b]);
        return true;
      },
    };
    let browserCalled = false;
    const r = await saveBlob(png(), 'grafico-btc.png', { bridge, browserSave: () => (browserCalled = true) });
    assert.deepEqual(calls, [['grafico-btc.png', 'image/png', 'iVBORw==']]);
    assert.equal(browserCalled, false);
    assert.equal(r.ok, true);
    assert.equal(r.via, 'native');
    assert.equal(r.message, 'Imagen guardada en Descargas');
  });

  it('APK: si el puente devuelve false, informa del fallo', async () => {
    const r = await saveBlob(png(), 'a.png', { bridge: { saveBase64: () => false } });
    assert.equal(r.ok, false);
    assert.match(r.message, /No se pudo guardar a\.png en Descargas/);
  });

  it('APK: si el puente lanza, no propaga la excepción', async () => {
    const r = await saveBlob(png(), 'a.png', {
      bridge: {
        saveBase64: () => {
          throw new Error('boom');
        },
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /boom/);
  });

  it('APK antiguo (WebView sin puente): pide instalar el APK nuevo', async () => {
    const r = await saveBlob(png(), 'a.png', { bridge: null, isApk: true, browserSave: () => assert.fail('no debe usar <a download>') });
    assert.equal(r.ok, false);
    assert.equal(r.message, NO_BRIDGE_MESSAGE);
  });

  it('Navegador: usa la descarga normal', async () => {
    const saved: string[] = [];
    const r = await saveBlob(png(), 'dir/../x.png', { bridge: null, isApk: false, browserSave: (_b, n) => saved.push(n) });
    assert.deepEqual(saved, ['x.png']);
    assert.equal(r.ok, true);
    assert.equal(r.via, 'browser');
    assert.equal(r.message, 'Imagen descargada: x.png');
  });
});

describe('saveFromUrl', () => {
  const okFetch = (async () => new Response(png(), { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;

  it('descarga la URL same-origin y la guarda con nombre derivado', async () => {
    let name = '';
    const r = await saveFromUrl('/api/history/7/result-image?v=1', undefined, {
      fetchFn: okFetch,
      bridge: null,
      isApk: false,
      browserSave: (_b, n) => (name = n),
    });
    assert.equal(r.ok, true);
    assert.equal(name, 'resultado-7.png');
  });

  it('404 → mensaje claro', async () => {
    const r = await saveFromUrl('/api/signals/chart?market=btc', null, {
      fetchFn: (async () => new Response('{}', { status: 404 })) as typeof fetch,
      bridge: null,
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /ya no está disponible/);
  });

  it('error de red → mensaje claro', async () => {
    const r = await saveFromUrl('/api/signals/chart?market=btc', null, {
      fetchFn: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      bridge: null,
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /servidor local/);
  });
});
