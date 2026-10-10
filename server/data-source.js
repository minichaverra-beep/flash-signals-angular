/**
 * Fuente de datos de gráficos/análisis: MT5 (puente) o solo Yahoo.
 *
 * Modos (`dataSource`): 'auto' | 'yahoo' | 'mt5'.
 *   - env FS_DATA_SOURCE (yahoo|mt5|auto) manda sobre el ajuste guardado en data/mt5-settings.json.
 *   - 'auto': Yahoo en Android/Termux (no hay MT5 en el móvil) o si no hay puente configurado;
 *     MT5 en el escritorio (si el puente no responde, Python cae solo a Yahoo con rótulo «sin MT5»).
 * `android/start.sh` exporta FS_DATA_SOURCE=yahoo, así que en el APK no depende de la detección.
 */

const MODES = ['auto', 'yahoo', 'mt5'];
const MODE_LABELS = { auto: 'Automática', yahoo: 'Solo Yahoo', mt5: 'MT5' };

/** @param {unknown} raw */
function normalizeMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'yfinance' || v === 'yahoo-only') return 'yahoo';
  return MODES.includes(v) ? v : null;
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
  const requested = forced ?? normalizeMode(settings.dataSource) ?? 'auto';
  if (requested === 'yahoo') return { mode: 'yahoo', requested, reason: forced ? 'FS_DATA_SOURCE=yahoo' : 'ajuste: solo Yahoo' };
  if (requested === 'mt5') return { mode: 'mt5', requested, reason: forced ? 'FS_DATA_SOURCE=mt5' : 'ajuste: MT5' };
  if (isAndroid(env)) return { mode: 'yahoo', requested, reason: 'Android/Termux: sin MT5' };
  if (!String(settings.bridgeUrl || '').trim()) return { mode: 'yahoo', requested, reason: 'puente MT5 sin configurar' };
  return { mode: 'mt5', requested, reason: 'escritorio con puente MT5' };
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

module.exports = { MODES, MODE_LABELS, normalizeMode, isAndroid, resolveDataSource, isYahooOnly, describeDataSource };
