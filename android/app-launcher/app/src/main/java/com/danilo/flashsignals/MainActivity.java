package com.danilo.flashsignals;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lanzador de Flash Signals: instala el stack en Termux (RUN_COMMAND) con el paquete
 * embebido en assets/, arranca el servidor y muestra la UI en un WebView.
 */
public class MainActivity extends Activity {

    private static final String TERMUX_PKG = "com.termux";
    private static final String TERMUX_PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final String TERMUX_BASH = "/data/data/com.termux/files/usr/bin/bash";
    private static final String TERMUX_HOME = "/data/data/com.termux/files/home";
    private static final String TERMUX_FDROID = "https://f-droid.org/packages/com.termux/";
    /** 2 = nueva sesión sin abrir la actividad: la abrimos nosotros (Android 10+ bloquea aperturas desde servicios). */
    private static final String SESSION_NEW_NO_ACTIVITY = "2";

    private static final String APP_URL = "http://127.0.0.1:3847/";
    private static final String HEALTH_URL = APP_URL + "api/health";

    private static final String DOWNLOAD_DIR = "Download/FlashSignals/";
    private static final String BUNDLE_ASSET = "flash-android.bundle";
    private static final String BUNDLE_FILE = "flash-android.tar.gz";
    private static final String INSTALLER_ASSET = "termux-install.sh";

    private static final String ENABLE_CMD =
            "mkdir -p ~/.termux && echo 'allow-external-apps = true' >> ~/.termux/termux.properties && termux-reload-settings";
    private static final String START_CMD = "bash ~/flash-server.sh";
    private static final String STOP_CMD =
            "pkill -f 'server/index.js'; pkill -f 'mt5-bridge/bridge.py'; pkill -f flash-mt5-tunnel.sh; "
                    + "pkill -f 'ssh -N -i .*flash_mt5'; termux-wake-unlock";

    private static final String PREFS = "flash";
    private static final String KEY_INSTALLED = "installed";

    private static final int REQ_PERMISSION = 1;
    private static final int REQ_FILE = 2;
    private static final int START_TIMEOUT_S = 150;

    private static final int BG = Color.parseColor("#1A1010");
    private static final int GOLD = Color.parseColor("#FFD700");
    private static final int MUTED = Color.parseColor("#D3D3D3");

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private View setupView;
    private TextView status;
    private Button btnTermux;
    private Button btnEnable;
    private Button btnInstall;
    private Button btnStart;
    private Button btnStop;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Runnable pendingAction;
    private volatile boolean waitingServer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        setupView = buildSetupView();
        setContentView(setupView);
        routeOnLaunch();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshButtons();
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- flujo

    private void routeOnLaunch() {
        setStatus("Buscando el servidor local…");
        io.execute(() -> {
            boolean up = isServerUp();
            ui.post(() -> {
                if (up) {
                    showWeb();
                } else if (isInstalled() && termuxInstalled() && hasRunPermission()) {
                    startServer();
                } else {
                    setStatus(isInstalled()
                            ? "Servidor detenido. Pulsa «Iniciar y abrir»."
                            : "Sigue los pasos 1 a 4 (solo la primera vez).");
                }
            });
        });
    }

    private void installBundle() {
        if (!assetExists(BUNDLE_ASSET) || !assetExists(INSTALLER_ASSET)) {
            setStatus("Este APK no trae el paquete. Genéralo con android\\build-apk.ps1 en el PC.");
            return;
        }
        withRunPermission(() -> {
            setBusy(true);
            io.execute(() -> {
                try {
                    String installer = exportToDownloads(INSTALLER_ASSET, INSTALLER_ASSET);
                    String bundle = exportToDownloads(BUNDLE_ASSET, BUNDLE_FILE);
                    String cmd = installCommand(bundle, installer);
                    ui.post(() -> {
                        setBusy(false);
                        prefs().edit().putBoolean(KEY_INSTALLED, true).apply();
                        if (runInTermux(cmd, false)) {
                            setStatus("Instalando en Termux (20–40 min la primera vez). "
                                    + "Acepta el permiso de almacenamiento. Al terminar vuelve aquí y pulsa «Iniciar y abrir».");
                            openTermux();
                        }
                    });
                } catch (IOException e) {
                    ui.post(() -> {
                        setBusy(false);
                        setStatus("No se pudo copiar el paquete a Download/: " + e.getMessage());
                    });
                }
            });
        });
    }

    private void startServer() {
        withRunPermission(() -> {
            if (!runInTermux(START_CMD, true)) return;
            waitForServer();
        });
    }

    private void stopServer() {
        withRunPermission(() -> {
            if (runInTermux(STOP_CMD, true)) {
                setStatus("Servidor detenido.");
                showSetup();
            }
        });
    }

    private void waitForServer() {
        if (waitingServer) return;
        waitingServer = true;
        setBusy(true);
        io.execute(() -> {
            for (int i = 0; i < START_TIMEOUT_S; i++) {
                if (isServerUp()) {
                    waitingServer = false;
                    ui.post(() -> {
                        setBusy(false);
                        showWeb();
                    });
                    return;
                }
                int elapsed = i;
                ui.post(() -> setStatus("Arrancando servidor… " + elapsed + " s"));
                sleep(1000);
            }
            waitingServer = false;
            ui.post(() -> {
                setBusy(false);
                setStatus("El servidor no respondió en " + START_TIMEOUT_S + " s. ¿Terminó la instalación? "
                        + "Revisa Termux o repite el paso 2 si Termux muestra «allow-external-apps».");
            });
        });
    }

    // ---------------------------------------------------------------- Termux

    private boolean termuxInstalled() {
        try {
            getPackageManager().getPackageInfo(TERMUX_PKG, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private boolean hasRunPermission() {
        return checkSelfPermission(TERMUX_PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    private void withRunPermission(Runnable action) {
        if (!termuxInstalled()) {
            setStatus("Primero instala Termux (paso 1).");
            return;
        }
        if (hasRunPermission()) {
            action.run();
            return;
        }
        pendingAction = action;
        requestPermissions(new String[]{TERMUX_PERMISSION}, REQ_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERMISSION) return;
        Runnable action = pendingAction;
        pendingAction = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED && action != null) {
            action.run();
        } else {
            setStatus("Sin el permiso «Ejecutar comandos en Termux» la app no puede instalar ni arrancar el servidor.");
        }
    }

    private boolean runInTermux(String command, boolean background) {
        Intent intent = new Intent("com.termux.RUN_COMMAND");
        intent.setClassName(TERMUX_PKG, "com.termux.app.RunCommandService");
        intent.putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_BASH);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", command});
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", background);
        intent.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", SESSION_NEW_NO_ACTIVITY);
        try {
            startForegroundService(intent);
            return true;
        } catch (RuntimeException e) {
            setStatus("Termux rechazó el comando: " + e.getMessage()
                    + ". Ábrelo una vez y repite el paso 2.");
            return false;
        }
    }

    private void openTermux() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(TERMUX_PKG);
        if (launch != null) startActivity(launch);
    }

    private static String installCommand(String bundle, String installer) {
        return "S=" + shellQuote(installer) + "; B=" + shellQuote(bundle) + "; "
                + "ls \"$S\" >/dev/null 2>&1 || termux-setup-storage; "
                + "for i in $(seq 1 120); do ls \"$S\" >/dev/null 2>&1 && break; sleep 1; done; "
                + "if ls \"$S\" >/dev/null 2>&1; then BUNDLE=\"$B\" bash \"$S\"; "
                + "else echo 'ERROR: Termux no tiene permiso de almacenamiento'; fi; "
                + "echo; echo '>> Vuelve a la app Flash Signals y pulsa Iniciar y abrir.'; "
                + "read -r -p 'Enter para cerrar' _";
    }

    private static String shellQuote(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    // ---------------------------------------------------------------- assets → Download/

    private boolean assetExists(String name) {
        try {
            return Arrays.asList(getAssets().list("")).contains(name);
        } catch (IOException e) {
            return false;
        }
    }

    /** Copia un asset a Download/FlashSignals/ con nombre fileName (MediaStore) y devuelve la ruta que ve Termux. */
    private String exportToDownloads(String asset, String fileName) throws IOException {
        ContentResolver cr = getContentResolver();
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String base = fileName.substring(0, fileName.indexOf('.'));
        cr.delete(collection,
                MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?",
                new String[]{DOWNLOAD_DIR, base + "%"});

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, DOWNLOAD_DIR);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = cr.insert(collection, values);
        if (item == null) throw new IOException("MediaStore no creó " + fileName);

        long total = 0;
        byte[] buf = new byte[1 << 16];
        try (InputStream in = getAssets().open(asset); OutputStream out = cr.openOutputStream(item)) {
            if (out == null) throw new IOException("sin acceso a " + item);
            int n;
            long nextReport = 0;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                total += n;
                if (total >= nextReport) {
                    long mb = total >> 20;
                    ui.post(() -> setStatus("Copiando " + fileName + "… " + mb + " MB"));
                    nextReport = total + (8L << 20);
                }
            }
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(item, values, null, null);

        String name = fileName;
        try (Cursor c = cr.query(item, new String[]{MediaStore.MediaColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        }
        return "/sdcard/" + DOWNLOAD_DIR + name;
    }

    // ---------------------------------------------------------------- servidor

    private static boolean isServerUp() {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(HEALTH_URL).openConnection();
            conn.setConnectTimeout(1500);
            conn.setReadTimeout(1500);
            return conn.getResponseCode() == 200;
        } catch (IOException e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private boolean isInstalled() {
        return prefs().getBoolean(KEY_INSTALLED, false);
    }

    // ---------------------------------------------------------------- WebView

    private void showWeb() {
        if (web == null) {
            web = new WebView(this);
            web.setBackgroundColor(BG);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setLoadWithOverviewMode(true);
            s.setUseWideViewPort(true);
            s.setAllowFileAccess(false);
            web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost())) return false;
                    openExternal(uri);
                    return true;
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                    if (fileCallback != null) fileCallback.onReceiveValue(null);
                    fileCallback = callback;
                    try {
                        startActivityForResult(params.createIntent(), REQ_FILE);
                        return true;
                    } catch (ActivityNotFoundException e) {
                        fileCallback = null;
                        return false;
                    }
                }
            });
            web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    Toast.makeText(this, "Descarga no soportada en la app: ábrela en Chrome (localhost:3847)",
                            Toast.LENGTH_LONG).show();
                } else {
                    openExternal(Uri.parse(url));
                }
            });
            web.loadUrl(APP_URL);
        }
        setContentView(web);
    }

    private void showSetup() {
        setContentView(setupView);
        refreshButtons();
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "No hay app para abrir " + uri, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.getParent() != null) {
            if (web.canGoBack()) {
                web.goBack();
            } else {
                showSetup();
            }
            return;
        }
        super.onBackPressed();
    }

    // ---------------------------------------------------------------- UI de configuración

    private View buildSetupView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        col.setPadding(pad, dp(28), pad, pad);
        scroll.addView(col);

        TextView title = text("FLASH SIGNALS", 26, GOLD);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        col.addView(title);
        col.addView(text("Cursor Trading en tu Android · servidor local en Termux", 14, MUTED));

        btnTermux = step(col, "1 · Instalar Termux (F-Droid)",
                "Termux ejecuta Node y Python en el teléfono. Usa F-Droid o GitHub, no Play Store. Ábrelo una vez al terminar.",
                v -> openExternal(Uri.parse(TERMUX_FDROID)));

        btnEnable = step(col, "2 · Permitir que Flash Signals use Termux",
                "Copia un comando y abre Termux: mantén pulsado en la pantalla → Pegar → Enter. Solo una vez.",
                v -> {
                    ClipboardManager cm = getSystemService(ClipboardManager.class);
                    cm.setPrimaryClip(ClipData.newPlainText("termux", ENABLE_CMD));
                    Toast.makeText(this, "Comando copiado: pégalo en Termux", Toast.LENGTH_LONG).show();
                    openTermux();
                });

        btnInstall = step(col, "3 · Instalar / actualizar Flash Signals",
                "Copia el paquete a Download/FlashSignals y lo instala en Termux (requiere Wi-Fi la primera vez). "
                        + "Actualizar conserva tu historial.",
                v -> installBundle());

        btnStart = step(col, "4 · Iniciar y abrir",
                "Arranca el servidor en segundo plano y abre la interfaz aquí mismo.",
                v -> {
                    setStatus("Comprobando servidor…");
                    io.execute(() -> {
                        boolean up = isServerUp();
                        ui.post(() -> {
                            if (up) showWeb();
                            else startServer();
                        });
                    });
                });

        btnStop = new Button(this);
        btnStop.setText("Detener servidor");
        btnStop.setAllCaps(false);
        btnStop.setOnClickListener(v -> stopServer());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(18);
        col.addView(btnStop, lp);

        status = text("", 14, Color.WHITE);
        status.setPadding(0, dp(18), 0, 0);
        col.addView(status);

        col.addView(text("Android 15: Ajustes → Apps → Termux → Batería → Sin restricciones, para que no detenga el servidor.",
                12, MUTED));
        return scroll;
    }

    private Button step(LinearLayout col, String label, String help, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(22);
        col.addView(b, lp);
        col.addView(text(help, 13, MUTED));
        return b;
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setPadding(0, dp(4), 0, 0);
        return t;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void refreshButtons() {
        if (btnTermux == null) return;
        boolean termux = termuxInstalled();
        btnTermux.setText(termux ? "1 · Termux instalado ✓" : "1 · Instalar Termux (F-Droid)");
        btnTermux.setEnabled(!termux);
        btnEnable.setEnabled(termux);
        btnInstall.setEnabled(termux && !waitingServer);
        btnStart.setEnabled(termux && !waitingServer);
        btnStop.setEnabled(termux);
    }

    private void setBusy(boolean busy) {
        btnInstall.setEnabled(!busy && termuxInstalled());
        btnStart.setEnabled(!busy && termuxInstalled());
    }

    private void setStatus(String s) {
        status.setText(s);
    }
}
