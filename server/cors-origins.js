/**
 * Orígenes permitidos por CORS. La API escucha en loopback; esto solo decide qué páginas del
 * navegador/WebView pueden leer sus respuestas. Nunca `*`.
 *
 * - Lista fija: Angular dev (4400), 8080, localhost sin puerto.
 * - Loopback de cualquier puerto (WebView/emulador/Termux): http(s)://localhost|127.0.0.1|[::1]|10.0.2.2[:puerto]
 * - Apps híbridas (Capacitor/Ionic/Cordova): capacitor://localhost, ionic://localhost, https://localhost
 * - Extensiones de Chrome: chrome-extension://<id de 32 letras a-p> SOLO si el id está en
 *   CORS_EXTENSION_IDS (CSV) o si CORS_ALLOW_ANY_EXTENSION=1.
 * - Extra explícito: CORS_ORIGINS (CSV).
 */

const BASE_ORIGINS = [
  'http://localhost:4400',
  'http://127.0.0.1:4400',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost',
  'http://127.0.0.1',
];

const HYBRID_APP_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'https://localhost'];

const LOOPBACK_ORIGIN_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10\.0\.2\.2)(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/;

const EXTENSION_ID_RE = /^[a-p]{32}$/;
const EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/;

const MAX_ORIGIN_LEN = 200;

function csv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @returns {(origin: string|undefined) => boolean}
 */
function createOriginMatcher(env = process.env) {
  const exact = new Set([...BASE_ORIGINS, ...HYBRID_APP_ORIGINS, ...csv(env.CORS_ORIGINS)]);
  const extensionIds = new Set(csv(env.CORS_EXTENSION_IDS).filter((id) => EXTENSION_ID_RE.test(id)));
  const anyExtension = env.CORS_ALLOW_ANY_EXTENSION === '1';

  return function isOriginAllowed(origin) {
    // Sin Origin (curl / mismo equipo / fetch same-origin): permitido.
    if (origin == null || origin === '') return true;
    if (typeof origin !== 'string' || origin.length > MAX_ORIGIN_LEN) return false;
    if (exact.has(origin) || LOOPBACK_ORIGIN_RE.test(origin)) return true;
    const ext = EXTENSION_ORIGIN_RE.exec(origin);
    return Boolean(ext && (anyExtension || extensionIds.has(ext[1])));
  };
}

module.exports = { createOriginMatcher, BASE_ORIGINS, HYBRID_APP_ORIGINS };
