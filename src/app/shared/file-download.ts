/**
 * Descarga de archivos que funciona igual en el navegador y en el WebView del APK.
 *
 * - Navegador: `<a download>` con un blob: URL.
 * - APK: el WebView NO sabe guardar blob:/data: URLs, así que el lanzador Android expone
 *   `window.AndroidDownloader.saveBase64(nombre, mime, base64)` (android/app-launcher, MainActivity)
 *   que escribe el archivo en la carpeta pública Descargas.
 *
 * Sin imports de Angular: se prueba con `node --test` (file-download.spec.ts).
 */

/** Puente nativo inyectado por MainActivity.java (`addJavascriptInterface`). */
export interface NativeDownloader {
  /** Guarda en Descargas. Devuelve true si se escribió el archivo. */
  saveBase64(filename: string, mime: string, base64: string): boolean | string | undefined | null;
}

export interface DownloadResult {
  ok: boolean;
  via: 'native' | 'browser' | 'none';
  filename: string;
  /** Mensaje en español listo para mostrar al usuario. */
  message: string;
}

/** Entorno inyectable (tests). Por defecto usa `window`/`document`. */
export interface DownloadEnv {
  bridge?: NativeDownloader | null;
  /** El WebView del APK (para avisar si el APK instalado es anterior al puente). Por defecto se deduce del UA. */
  isApk?: boolean;
  /** Guarda un blob con `<a download>`; por defecto lo hace con el DOM. */
  browserSave?: (blob: Blob, filename: string) => void;
  fetchFn?: typeof fetch;
}

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

export const NO_BRIDGE_MESSAGE =
  'Esta versión de la app no puede guardar archivos. Instala el APK nuevo (release-android.ps1) y vuelve a intentarlo.';

export function getNativeDownloader(win: unknown = typeof window === 'undefined' ? undefined : window): NativeDownloader | null {
  const b = (win as { AndroidDownloader?: NativeDownloader } | undefined)?.AndroidDownloader;
  return b && typeof b.saveBase64 === 'function' ? b : null;
}

/** WebView de Android (UA con «; wv)»): ahí `<a download>` con blob: no funciona. */
export function isWebViewUa(ua: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.userAgent): boolean {
  return !!ua && /Android/i.test(ua) && /;\s*wv\)/i.test(ua);
}

/** Nombre apto para el sistema de archivos de Android/Windows (sin rutas ni caracteres reservados). */
export function sanitizeFilename(name: string | null | undefined, fallback = 'descarga'): string {
  let n = String(name ?? '').split(/[\\/]/).pop() ?? '';
  n = n.replaceAll(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  return n.slice(0, 120) || fallback;
}

export function extensionForMime(mime: string | null | undefined): string {
  const m = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[m] ?? '';
}

function stamp(now: Date): string {
  return now.toISOString().slice(0, 16).replaceAll(/[-:T]/g, '');
}

/**
 * Nombre sugerido para una imagen a partir de su URL de la API:
 *  /api/history/12/result-image?v=3   → resultado-12.png
 *  /api/signals/chart?market=btc      → grafico-btc.png
 *  /api/signals/macd-chart?market=eth → macd-h4-eth.png
 *  /api/signals/macd-quant/history/5/chart → macd-quant-5.png
 *  otra URL                           → último segmento o imagen-<fecha>.png
 */
export function suggestImageFilename(url: string, mime?: string | null, now = new Date()): string {
  const ext = extensionForMime(mime) || '.png';
  let path = '';
  let params = new URLSearchParams();
  try {
    const u = new URL(url, 'http://local.invalid');
    path = u.pathname;
    params = u.searchParams;
  } catch {
    path = String(url).split(/[?#]/)[0];
  }
  const market = (params.get('market') || '').toLowerCase().replaceAll(/[^a-z0-9_-]/g, '');
  let m = /\/history\/(\d+)\/result-image\/?$/.exec(path);
  if (m) return `resultado-${m[1]}${ext}`;
  m = /\/macd-quant\/history\/(\d+)\/chart\/?$/.exec(path);
  if (m) return `macd-quant-${m[1]}${ext}`;
  if (/\/signals\/macd-chart\/?$/.test(path)) return `macd-h4-${market || 'btc'}${ext}`;
  if (/\/signals\/chart\/?$/.test(path)) return `grafico-${market || 'btc'}${ext}`;
  const last = decodeSegment(path.split('/').filter(Boolean).pop() ?? '');
  if (/^[\w. -]+\.[A-Za-z0-9]{2,5}$/.test(last)) return sanitizeFilename(last);
  return `imagen-${stamp(now)}${ext}`;
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Base64 (sin prefijo data:) de un blob. */
export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader === 'undefined') {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el archivo'));
    reader.onload = () => {
      const s = String(reader.result ?? '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.readAsDataURL(blob);
  });
}

function browserSaveDom(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Etiqueta humana del tipo de archivo para los mensajes («Imagen», «Excel», «PDF»…). */
export function describeKind(filename: string, mime?: string | null): string {
  const f = filename.toLowerCase();
  const m = String(mime ?? '').toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/.test(f)) return 'Imagen';
  if (m === 'application/pdf' || f.endsWith('.pdf')) return 'PDF';
  if (/\.(xlsx|xls)$/.test(f) || m.includes('spreadsheetml')) return 'Excel';
  if (f.endsWith('.csv')) return 'CSV';
  if (f.endsWith('.zip')) return 'ZIP';
  return 'Archivo';
}

/** Guarda un blob: en Descargas (APK) o con la descarga normal del navegador. */
export async function saveBlob(blob: Blob, filename: string, env: DownloadEnv = {}): Promise<DownloadResult> {
  const name = sanitizeFilename(filename);
  const kind = describeKind(name, blob.type);
  const bridge = env.bridge === undefined ? getNativeDownloader() : env.bridge;
  try {
    if (bridge) {
      const base64 = await blobToBase64(blob);
      const res = bridge.saveBase64(name, blob.type || 'application/octet-stream', base64);
      const ok = res === true || res === 'true' || res === undefined;
      return ok
        ? { ok: true, via: 'native', filename: name, message: `${kind} guardada en Descargas` }
        : { ok: false, via: 'native', filename: name, message: `No se pudo guardar ${name} en Descargas` };
    }
    if (env.isApk ?? isWebViewUa()) {
      return { ok: false, via: 'none', filename: name, message: NO_BRIDGE_MESSAGE };
    }
    (env.browserSave ?? browserSaveDom)(blob, name);
    return { ok: true, via: 'browser', filename: name, message: `${kind} descargada: ${name}` };
  } catch (err) {
    const detail = err instanceof Error && err.message ? `: ${err.message}` : '';
    return {
      ok: false,
      via: bridge ? 'native' : 'browser',
      filename: name,
      message: `No se pudo guardar el archivo${detail}`,
    };
  }
}

/**
 * Descarga una URL same-origin de la API (p. ej. un PNG) como blob y la guarda.
 * No abre pestañas ni navega: la app (WebView) nunca se reemplaza.
 */
export async function saveFromUrl(url: string, filename?: string | null, env: DownloadEnv = {}): Promise<DownloadResult> {
  const fetchFn = env.fetchFn ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);
  const fallbackName = sanitizeFilename(filename || suggestImageFilename(url));
  if (!fetchFn) {
    return { ok: false, via: 'none', filename: fallbackName, message: 'Este navegador no permite descargar archivos' };
  }
  try {
    const res = await fetchFn(url, { cache: 'no-store' });
    if (!res.ok) {
      return {
        ok: false,
        via: 'none',
        filename: fallbackName,
        message: res.status === 404 ? 'La imagen ya no está disponible en el servidor' : `No se pudo descargar (HTTP ${res.status})`,
      };
    }
    const blob = await res.blob();
    const name = filename || suggestImageFilename(url, blob.type);
    return await saveBlob(blob, name, env);
  } catch {
    return {
      ok: false,
      via: 'none',
      filename: fallbackName,
      message: 'No se pudo descargar: comprueba que el servidor local esté en marcha',
    };
  }
}
