/**
 * Carga del PNG del gráfico de entrada para pintarlo en el canvas del póster.
 *
 * En el WebView del APK un `new Image()` suelto a veces falla o no termina de decodificar y el
 * póster se pintaba sin velas, sin decir por qué. Aquí el PNG se pide con `fetch` same-origin
 * (credenciales incluidas), se convierte en blob → object URL, se espera la decodificación y,
 * si algo falla, se devuelve un motivo en español para enseñarlo al usuario.
 *
 * Sin imports de Angular: se prueba con `node --test` (chart-image.spec.ts).
 */

export interface ChartImageLoad {
  img: HTMLImageElement | null;
  /** Motivo legible si `img` es null. */
  error: string | null;
  /** Libera el object URL (llamar cuando el canvas ya se pintó). */
  revoke: () => void;
}

/** Imagen mínima que necesita el cargador (inyectable en tests). */
export interface ImageLike {
  src: string;
  crossOrigin?: string | null;
  naturalWidth: number;
  naturalHeight: number;
  onload: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  decode?: () => Promise<void>;
}

export interface ChartImageEnv {
  fetchFn?: typeof fetch;
  createImage?: () => ImageLike;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** Tiempo máximo total (fetch + decodificación). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function chartLoadErrorMessage(status: number | null, detail?: string | null): string {
  if (status === 404) return 'No se pudo cargar el gráfico: el servidor no tiene el PNG de entrada (HTTP 404)';
  if (status != null) return `No se pudo cargar el gráfico: HTTP ${status}`;
  const why = String(detail || '').trim();
  return `No se pudo cargar el gráfico: ${why || 'sin respuesta del servidor local'}`;
}

/** Descarga el PNG same-origin. Nunca lanza: devuelve el blob o el motivo. */
export async function fetchChartBlob(
  src: string,
  fetchFn: typeof fetch | undefined = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined,
): Promise<{ blob: Blob; error: null } | { blob: null; error: string }> {
  if (!fetchFn) return { blob: null, error: chartLoadErrorMessage(null, 'este navegador no permite fetch') };
  let res: Response;
  try {
    res = await fetchFn(src, { credentials: 'same-origin', cache: 'no-store' });
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : 'fallo de red';
    return { blob: null, error: chartLoadErrorMessage(null, detail) };
  }
  if (!res.ok) return { blob: null, error: chartLoadErrorMessage(res.status) };
  let blob: Blob;
  try {
    blob = await res.blob();
  } catch {
    return { blob: null, error: chartLoadErrorMessage(null, 'no se pudo leer la respuesta') };
  }
  if (!blob || blob.size < 24) return { blob: null, error: chartLoadErrorMessage(null, 'el PNG llegó vacío') };
  const type = String(blob.type || '').toLowerCase();
  if (type && !type.startsWith('image/')) {
    return { blob: null, error: chartLoadErrorMessage(null, `la respuesta no es una imagen (${type})`) };
  }
  return { blob, error: null };
}

function decodeInto(img: ImageLike, url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(error);
    };
    const timer = setTimeout(() => finish('la imagen tardó demasiado en decodificarse'), timeoutMs);
    img.onload = () => {
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) {
        finish('la imagen se decodificó vacía (0×0)');
        return;
      }
      const decode = typeof img.decode === 'function' ? img.decode.call(img) : null;
      if (decode && typeof decode.then === 'function') {
        // decode() puede fallar en WebViews viejos aunque onload ya diera tamaño: con tamaño basta.
        decode.then(() => finish(null), () => finish(null));
      } else {
        finish(null);
      }
    };
    img.onerror = () => finish('el navegador no pudo decodificar el PNG');
    img.src = url;
  });
}

/**
 * fetch → blob → object URL → Image decodificada. Si el blob falla, intenta la URL directa
 * (misma política que antes) para no perder el gráfico por un fetch bloqueado.
 */
export async function loadChartImage(src: string, env: ChartImageEnv = {}): Promise<ChartImageLoad> {
  const timeoutMs = env.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createImage = env.createImage ?? (() => new Image() as unknown as ImageLike);
  const createUrl = env.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl = env.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const noop = () => {};

  const started = Date.now();
  const fetched = await fetchChartBlob(src, env.fetchFn);
  const left = () => Math.max(1500, timeoutMs - (Date.now() - started));

  if (fetched.blob) {
    const url = createUrl(fetched.blob);
    const img = createImage();
    const error = await decodeInto(img, url, left());
    if (!error) return { img: img as unknown as HTMLImageElement, error: null, revoke: () => revokeUrl(url) };
    revokeUrl(url);
    const direct = createImage();
    if (/^https?:\/\//i.test(src)) direct.crossOrigin = 'anonymous';
    const directError = await decodeInto(direct, src, left());
    if (!directError) return { img: direct as unknown as HTMLImageElement, error: null, revoke: noop };
    return { img: null, error: chartLoadErrorMessage(null, error), revoke: noop };
  }

  // fetch falló (p. ej. 404): la URL directa daría lo mismo, salvo que el fallo fuera del propio fetch.
  if (!/HTTP \d{3}/.test(fetched.error)) {
    const direct = createImage();
    if (/^https?:\/\//i.test(src)) direct.crossOrigin = 'anonymous';
    const directError = await decodeInto(direct, src, left());
    if (!directError) return { img: direct as unknown as HTMLImageElement, error: null, revoke: noop };
  }
  return { img: null, error: fetched.error, revoke: noop };
}
