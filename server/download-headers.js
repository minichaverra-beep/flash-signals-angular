/**
 * Descargas de archivos servidos por la API (PNG de gráficos, captura de resultado, artefactos).
 *
 * `?download=1` (o `true`/`yes`) convierte la respuesta en `Content-Disposition: attachment`, que es lo
 * que dispara el DownloadListener del WebView del APK (y la descarga nativa en cualquier navegador).
 * `?filename=` solo sugiere el nombre: se sanea (sin rutas, sin caracteres de control) y NUNCA elige
 * qué archivo se sirve; la ruta del archivo siempre la decide el servidor.
 */

const path = require('node:path');

const MAX_NAME_LEN = 120;
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf', '.html', '.htm', '.csv', '.xlsx', '.json', '.txt', '.md', '.zip']);

function isDownloadRequested(query) {
  const raw = query && query.download;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && /^(1|true|yes|si|sí)$/i.test(v.trim());
}

/**
 * Nombre de archivo seguro: solo basename, sin separadores ni `..`, sin caracteres de control ni
 * reservados de Windows, longitud acotada. Si queda vacío usa `fallback`.
 */
function sanitizeDownloadName(raw, fallback = 'descarga') {
  const value = Array.isArray(raw) ? raw[0] : raw;
  let name = typeof value === 'string' ? value : '';
  name = name.split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  name = name.replaceAll(/[\u0000-\u001f\u007f"<>:|?*]/g, '').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (name.length > MAX_NAME_LEN) {
    const ext = path.extname(name);
    const keep = ALLOWED_EXT.has(ext.toLowerCase()) ? ext : '';
    name = name.slice(0, MAX_NAME_LEN - keep.length) + keep;
  }
  return name || fallback;
}

/** Valor del header con filename ASCII + filename* UTF-8 (RFC 6266 / 5987). */
function contentDisposition(filename) {
  const ascii = filename.replaceAll(/[^\x20-\x7e]/g, '_').replaceAll(/["\\%]/g, '_');
  const utf8 = encodeURIComponent(filename).replaceAll(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Si la petición pide descarga, fija `Content-Disposition: attachment`. Devuelve true si lo hizo.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} fallbackName nombre por defecto (incluye extensión), p. ej. `grafico-btc.png`
 */
function applyDownloadHeaders(req, res, fallbackName) {
  if (!isDownloadRequested(req.query)) return false;
  const fallback = sanitizeDownloadName(fallbackName, 'descarga');
  const name = sanitizeDownloadName(req.query.filename, fallback);
  res.setHeader('Content-Disposition', contentDisposition(name));
  return true;
}

module.exports = { isDownloadRequested, sanitizeDownloadName, contentDisposition, applyDownloadHeaders };
