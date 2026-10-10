package com.danilo.flashsignals;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Descargas dentro del WebView: guarda en la carpeta pública Descargas (MediaStore; minSdk 29, no hace
 * falta permiso de almacenamiento) y avisa con un Toast.
 *
 * <ul>
 *   <li>La página llama a {@code AndroidDownloader.saveBase64(nombre, mime, base64)} (ver
 *       src/app/shared/file-download.ts): es el camino normal para PNG/Excel/PDF generados en el cliente.</li>
 *   <li>{@link #handle} es el DownloadListener del WebView: http(s) de la propia app (p. ej.
 *       {@code /api/...?download=1} con Content-Disposition: attachment), data: y blob:.</li>
 * </ul>
 */
final class DownloadBridge {

    /** Nombre con el que se expone a JavaScript (window.AndroidDownloader). */
    static final String JS_NAME = "AndroidDownloader";

    private static final long MAX_BYTES = 150L << 20;

    private final Activity activity;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    DownloadBridge(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    void shutdown() {
        io.shutdownNow();
    }

    // ---------------------------------------------------------------- API para JavaScript

    /** Guarda en Descargas. Se ejecuta en un hilo de WebView (no el principal). */
    @JavascriptInterface
    public boolean saveBase64(String filename, String mime, String base64) {
        try {
            if (base64 == null || base64.isEmpty()) throw new IOException("archivo vacío");
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            if (data.length > MAX_BYTES) throw new IOException("archivo demasiado grande");
            String name = save(filename, mime, new ByteArrayInputStream(data));
            toast("Guardado en Descargas: " + name);
            return true;
        } catch (IOException | RuntimeException e) {
            toast("No se pudo guardar: " + e.getMessage());
            return false;
        }
    }

    /** Lo usa el JS inyectado para blob: cuando fetch/lectura falla. */
    @JavascriptInterface
    public void fail(String message) {
        toast("No se pudo guardar: " + message);
    }

    // ---------------------------------------------------------------- DownloadListener

    /**
     * @return false si la URL no es de la propia app (el llamador la abre fuera, como antes).
     */
    boolean handle(String url, String disposition, String mime) {
        if (url == null) return false;
        String name = URLUtil.guessFileName(url, disposition, mime);
        if (url.startsWith("blob:")) {
            saveBlobUrl(url, name, mime);
            return true;
        }
        if (url.startsWith("data:")) {
            io.execute(() -> saveDataUrl(url, name, mime));
            return true;
        }
        Uri uri = Uri.parse(url);
        String host = uri.getHost();
        if (("127.0.0.1".equals(host) || "localhost".equals(host))
                && ("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))) {
            io.execute(() -> saveHttp(url, name, mime));
            return true;
        }
        return false;
    }

    private void saveBlobUrl(String url, String name, String mime) {
        String js = "(function(u,n,m){var B=window." + JS_NAME + ";"
                + "fetch(u).then(function(r){return r.blob();}).then(function(b){"
                + "var f=new FileReader();"
                + "f.onloadend=function(){var s=String(f.result||'');"
                + "B.saveBase64(n,m||b.type||'application/octet-stream',s.substring(s.indexOf(',')+1));};"
                + "f.onerror=function(){B.fail('lectura');};"
                + "f.readAsDataURL(b);"
                + "}).catch(function(e){B.fail(String(e));});})("
                + JSONObject.quote(url) + "," + JSONObject.quote(name) + "," + JSONObject.quote(mime == null ? "" : mime) + ")";
        ui.post(() -> web.evaluateJavascript(js, null));
    }

    private void saveDataUrl(String url, String name, String mime) {
        try {
            int comma = url.indexOf(',');
            if (comma < 0) throw new IOException("data: inválido");
            String meta = url.substring(5, comma);
            String payload = url.substring(comma + 1);
            byte[] data = meta.endsWith(";base64")
                    ? Base64.decode(payload, Base64.DEFAULT)
                    : Uri.decode(payload).getBytes(java.nio.charset.StandardCharsets.UTF_8);
            String realMime = mime != null && !mime.isEmpty() ? mime
                    : (meta.contains(";") ? meta.substring(0, meta.indexOf(';')) : meta);
            String saved = save(name, realMime, new ByteArrayInputStream(data));
            toast("Guardado en Descargas: " + saved);
        } catch (IOException | RuntimeException e) {
            toast("No se pudo guardar: " + e.getMessage());
        }
    }

    private void saveHttp(String url, String name, String mime) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(30_000);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) conn.setRequestProperty("Cookie", cookies);
            if (conn.getResponseCode() != 200) throw new IOException("HTTP " + conn.getResponseCode());
            String type = mime;
            if (type == null || type.isEmpty() || "application/octet-stream".equals(type)) {
                String ct = conn.getContentType();
                if (ct != null) type = ct.split(";")[0].trim();
            }
            try (InputStream in = conn.getInputStream()) {
                String saved = save(name, type, in);
                toast("Guardado en Descargas: " + saved);
            }
        } catch (IOException | RuntimeException e) {
            toast("No se pudo guardar: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ---------------------------------------------------------------- MediaStore

    /** Escribe en Descargas y devuelve el nombre final (MediaStore añade « (1)» si ya existía). */
    private String save(String filename, String mime, InputStream in) throws IOException {
        String name = safeName(filename);
        String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
        ContentResolver resolver = activity.getContentResolver();

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("MediaStore rechazó el archivo");

        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("no se pudo abrir el destino");
            byte[] buf = new byte[16 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) throw new IOException("archivo demasiado grande");
                out.write(buf, 0, n);
            }
        } catch (IOException | RuntimeException e) {
            resolver.delete(uri, null, null);
            throw e instanceof IOException ? (IOException) e : new IOException(e.getMessage(), e);
        }

        ContentValues done = new ContentValues();
        done.put(MediaStore.MediaColumns.IS_PENDING, 0);
        resolver.update(uri, done, null, null);
        return displayName(resolver, uri, name);
    }

    private static String displayName(ContentResolver resolver, Uri uri, String fallback) {
        try (android.database.Cursor c = resolver.query(uri, new String[]{MediaStore.MediaColumns.DISPLAY_NAME},
                null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (RuntimeException ignored) {
            // el nombre solo se usa para el aviso
        }
        return fallback;
    }

    /** Sin rutas ni caracteres reservados; nunca vacío. */
    static String safeName(String raw) {
        String n = raw == null ? "" : raw;
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replaceAll("[\\p{Cntrl}\"<>:|?*]", "").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.length() > 120) n = n.substring(0, 120);
        if (n.isEmpty()) return "descarga-" + System.currentTimeMillis();
        // Nombre genérico de URLUtil.guessFileName cuando no hay nada mejor.
        if (n.toLowerCase(Locale.ROOT).equals("downloadfile.bin")) return "descarga-" + System.currentTimeMillis() + ".bin";
        return n;
    }

    private void toast(String message) {
        ui.post(() -> Toast.makeText(activity, message, Toast.LENGTH_LONG).show());
    }
}
