/**
 * Fuente de datos de gráficos/análisis: MT5 (puente) o solo Yahoo.
 *
 * Modos (`dataSource`): 'yahoo' | 'mt5' | 'auto' (legado).
 *   - Por defecto, y si el ajuste falta: solo Yahoo.
 *   - Android/Termux y pantalla pequeña (cabecera X-FS-Client: small) siempre Yahoo,
 *     aunque el ajuste guardado o FS_DATA_SOURCE digan mt5 o auto.
 *   - Una petición HTTP sin sesión admin también queda en Yahoo (el JSON puede seguir diciendo mt5).
 *   - 'mt5' usa el puente en el escritorio si la petición es de un admin, o si no hay petición HTTP.
 *   - 'auto' (legado, ya no es el defecto): Yahoo sin puente; MT5 en el escritorio con puente, con las mismas excepciones.
 * `android/start.sh` fija FS_DATA_SOURCE=yahoo; el APK no depende de que el entorno sobreviva al empaquetado.
 */

const { AsyncLocalStorage } = require('node:async_hooks');

const MODES = ['auto', 'yahoo', 'mt5'];
const MODE_LABELS = { auto: 'Automática', yahoo: 'Solo Yahoo', mt5: 'MT5' };

/** @param {unknown} raw */
function normalizeMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'yfinance' || v === 'yahoo-only') return 'yahoo';
  return MODES.includes(v) ? v : null;
}

/** Cabecera X-FS-Client: small (navegador ≤768 px o APK). Siempre solo Yahoo. */
const clientContext = new AsyncLocalStorage();

/** (req) => boolean. index.js lo enlaza con el token admin; sin enlace toda petición HTTP es no-admin. */
let adminChecker = () => false;

function setAdminChecker(fn) {
  adminChecker = typeof fn === 'function' ? fn : () => false;
}

function clientContextMiddleware(req, _res, next) {
  const smallScreen = String(req.headers['x-fs-client'] || '') === 'small';
  const admin = adminChecker(req) === true;
  clientContext.run({ smallScreen, admin }, () => next());
}

function isSmallScreen() {
  return clientContext.getStore()?.smallScreen === true;
}

/** Petición HTTP presente y sin sesión admin. Sin store (scripts, tests, arranque) no aplica. */
function isNonAdminClient() {
  const store = clientContext.getStore();
  return !!store && store.admin !== true;
}

/** True dentro de Termux o del proot de Ubuntu lanzado desde Termux. */
function isAndroid(env = process.env) {
  if (env.TERMUX_VERSION) return true;
  if (String(env.PREFIX || '').includes('com.termux')) return true;
  if (env.ANDROID_ROOT || env.ANDROID_DATA) return true;
  return false;
}

/**
 * Modo efectivo para lanzar scripts: 'yahoo' o 'mt5'.
 * @param {{ dataSource?: string, bridgeUrl?: string }} [settings]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ mode: 'yahoo' | 'mt5', requested: string, reason: string }}
 */
function resolveDataSource(settings = {}, env = process.env) {
  if (/^(1|true|yes|on)$/i.test(String(env.FS_DISABLE_MT5 ?? '').trim())) {
    return { mode: 'yahoo', requested: 'yahoo', reason: 'FS_DISABLE_MT5=1' };
  }
  const forced = normalizeMode(env.FS_DATA_SOURCE);
  const requested = forced ?? normalizeMode(settings.dataSource) ?? 'yahoo';
  if (isAndroid(env)) return { mode: 'yahoo', requested, reason: 'Android/Termux: solo Yahoo' };
  if (isSmallScreen()) return { mode: 'yahoo', requested, reason: 'pantalla pequeña: solo Yahoo' };
  if (requested === 'yahoo') return { mode: 'yahoo', requested, reason: forced ? 'FS_DATA_SOURCE=yahoo' : 'ajuste: solo Yahoo' };
  if (isNonAdminClient()) return { mode: 'yahoo', requested, reason: 'sin admin: solo Yahoo' };
  if (requested === 'mt5') return { mode: 'mt5', requested, reason: forced ? 'FS_DATA_SOURCE=mt5' : 'ajuste: MT5' };
  if (!String(settings.bridgeUrl || '').trim()) return { mode: 'yahoo', requested, reason: 'puente MT5 sin configurar' };
  return { mode: 'mt5', requested, reason: forced ? 'FS_DATA_SOURCE=auto' : 'escritorio con puente MT5' };
}

/** True si MT5 debe ignorarse del todo (ni puente ni velas del broker). */
function isYahooOnly(settings, env = process.env) {
  return resolveDataSource(settings, env).mode === 'yahoo';
}

/** Línea para el log del job: qué fuente se usará y por qué. */
function describeDataSource(settings, env = process.env) {
  const { mode, reason } = resolveDataSource(settings, env);
  return mode === 'yahoo'
    ? `[datos] Fuente: solo Yahoo (${reason}); MT5 omitido`
    : `[datos] Fuente: MT5 con respaldo Yahoo (${reason})`;
}

module.exports = {
  MODES, MODE_LABELS, normalizeMode, isAndroid, isSmallScreen, setAdminChecker, clientContextMiddleware,
  resolveDataSource, isYahooOnly, describeDataSource,
};
