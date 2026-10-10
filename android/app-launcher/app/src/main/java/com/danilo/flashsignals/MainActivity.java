package com.danilo.flashsignals;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.InputType;
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
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Lanzador de Flash Signals: asistente que detecta el estado (Termux, permisos, versión instalada,
 * servidor), instala el paquete embebido en assets/ (o el que sirve el PC por Wi-Fi), arranca el
 * servidor en Termux y muestra la UI en un WebView.
 */
public class MainActivity extends Activity {

    private static final String TERMUX_PKG = "com.termux";
    private static final String TERMUX_SERVICE = "com.termux.app.RunCommandService";
    private static final String TERMUX_PERMISSION = "com.termux.permission.RUN_COMMAND";
    private static final String TERMUX_BASH = "/data/data/com.termux/files/usr/bin/bash";
    private static final String TERMUX_HOME = "/data/data/com.termux/files/home";
    private static final String TERMUX_FDROID = "https://f-droid.org/packages/com.termux/";
    private static final String TERMUX_GITHUB = "https://github.com/termux/termux-app/releases/latest";
    /** 2 = nueva sesión sin abrir la actividad: la abrimos nosotros (Android 10+ bloquea aperturas desde servicios). */
    private static final String SESSION_NEW_NO_ACTIVITY = "2";

    private static final String APP_URL = "http://127.0.0.1:3847/";
    private static final String HEALTH_URL = APP_URL + "api/health";

    private static final String BUNDLE_ASSET = "flash-android.bundle";
    private static final String INSTALLER_ASSET = "termux-install.sh";
    private static final String VERSION_ASSET = "flash-version.txt";

    // Los patrones de pgrep/pkill llevan [x]: si no, coinciden con la línea de comandos del propio bash -c.
    private static final String ENABLE_CMD = "mkdir -p ~/.termux && "
            + "(grep -q '^allow-external-apps *= *true' ~/.termux/termux.properties 2>/dev/null "
            + "|| echo 'allow-external-apps = true' >> ~/.termux/termux.properties) && termux-reload-settings";
    private static final String STATUS_CMD = String.join("\n",
            "v=$(cat ~/.flash-version 2>/dev/null)",
            "s=$(cat ~/.flash-install-state 2>/dev/null)",
            "echo FLASH_OK",
            "echo \"version=$v\"",
            "echo \"install=$s\"",
            "[ -f ~/flash-server.sh ] && echo installed=1",
            "pgrep -f 'termux-instal[l]\\.sh' >/dev/null && echo installing=1",
            "pgrep -f 'server/inde[x]\\.js' >/dev/null && echo server=1",
            "case \"$s\" in failed*|running) echo '--log--'; tail -n 15 ~/flash-install.log 2>/dev/null;; esac",
            "true");
    private static final String START_CMD = "bash ~/flash-server.sh >~/flash-server.log 2>&1";
    private static final String ALIVE_CMD = String.join("\n",
            "pgrep -f 'start\\.s[h]|server/inde[x]\\.js' >/dev/null && echo alive=1",
            "echo FLASH_OK",
            "echo '--log--'",
            "tail -n 20 ~/flash-server.log 2>/dev/null",
            "true");
    private static final String STOP_CMD = "pkill -f 'server/inde[x]\\.js'; pkill -f 'mt5-bridge/bridg[e]\\.py'; "
            + "pkill -f 'flash-mt5-tunne[l]\\.sh'; pkill -f 'ssh -N -i .*flash_mt[5]'; termux-wake-unlock; echo FLASH_OK";
    private static final String BACK_TO_APP = "echo; echo '>> Vuelve a la app Flash Signals: comprobará la instalación y arrancará sola.'; "
            + "read -r -p 'Pulsa Enter para cerrar esta sesión ' _";

    private static final Pattern URL_OK =
            Pattern.compile("^https?://[A-Za-z0-9.\\-]+(:\\d{1,5})?(/[A-Za-z0-9._~/\\-]*)?$");

    private static final String PREFS = "flash";
    private static final String KEY_PC_URL = "pc_url";
    private static final String KEY_PERM_ASKED = "perm_asked";

    private static final int REQ_PERMISSION = 1;
    private static final int REQ_FILE = 2;
    private static final int START_TIMEOUT_S = 90;
    private static final long PROBE_TIMEOUT_MS = 10_000;
    private static final long COPY_TIMEOUT_MS = 20 * 60_000;

    private static final int BG = Color.parseColor("#1A1010");
    private static final int PANEL = Color.parseColor("#2A1C1C");
    private static final int GOLD = Color.parseColor("#FFD700");
    private static final int MUTED = Color.parseColor("#D3D3D3");
    private static final int OK_GREEN = Color.parseColor("#7CD67C");
    private static final int WARN = Color.parseColor("#FFB347");

    private enum State {
        CHECKING, NEED_TERMUX, TERMUX_INCOMPATIBLE, NEED_PERMISSION, TERMUX_NOT_READY, NEED_ENABLE,
        NEED_INSTALL, NEED_UPDATE, COPYING, INSTALLING, INSTALL_FAILED, READY, STARTING, START_FAILED, RUNNING
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private State state = State.CHECKING;
    private String bundledVersion = "";
    private String installedVersion = "";
    private boolean installedKnown;
    private boolean termuxAccepts;
    private boolean probing;
    private boolean autoStarted;
    private boolean userStopped;
    private boolean resumedOnce;
    private Boolean bundlePresent;
    private String detail = "";
    private String log = "";
    private long startedAt;
    private int lastAliveCheck;
    private int deadChecks;

    private View setupView;
    private TextView chkTermux;
    private TextView chkPermission;
    private TextView chkEnabled;
    private TextView chkInstalled;
    private TextView chkBattery;
    private Button btnPrimary;
    private TextView help;
    private TextView status;
    private TextView logView;
    private Button btnAlt;
    private Button btnBattery;
    private Button btnPc;
    private Button btnReinstall;
    private Button btnStop;
    private Button btnRecheck;
    private WebView web;
    private DownloadBridge downloads;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        bundledVersion = readAsset(VERSION_ASSET).trim();
        rememberPcUrl(getIntent());
        setupView = buildSetupView();
        setContentView(setupView);
        launchCheck();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        rememberPcUrl(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (resumedOnce && !webVisible() && state != State.COPYING && state != State.STARTING) {
            refresh();
        }
        resumedOnce = true;
    }

    @Override
    protected void onDestroy() {
        io.shutdownNow();
        if (downloads != null) downloads.shutdown();
        super.onDestroy();
    }

    // ---------------------------------------------------------------- detección de estado

    private void launchCheck() {
        setState(State.CHECKING, "Buscando el servidor local…");
        io.execute(() -> {
            boolean up = isServerUp();
            ui.post(() -> {
                if (up) {
                    setState(State.RUNNING, "");
                    showWeb();
                } else {
                    refresh();
                }
            });
        });
    }

    /** Recorre los requisitos en orden y deja la app en el primer paso pendiente. */
    private void refresh() {
        if (!termuxInstalled()) {
            setState(State.NEED_TERMUX, "");
            return;
        }
        if (!termuxSupportsRunCommand()) {
            setState(State.TERMUX_INCOMPATIBLE, "");
            return;
        }
        if (!hasRunPermission()) {
            setState(State.NEED_PERMISSION, "");
            return;
        }
        if (probing) return;
        probing = true;
        setState(State.CHECKING, "Comprobando Termux…");
        termux(STATUS_CMD, PROBE_TIMEOUT_MS, r -> {
            probing = false;
            onStatus(r);
        });
    }

    private void onStatus(TermuxResult r) {
        if (!r.ok()) {
            termuxAccepts = false;
            if (r.timedOut || r.errmsg.contains("allow-external-apps")) {
                setState(State.NEED_ENABLE, r.timedOut
                        ? "Termux no respondió. Si ya pegaste el comando, cierra Termux (Exit en su notificación) y vuelve."
                        : "");
            } else {
                log = r.describe();
                setState(State.TERMUX_NOT_READY, "");
            }
            return;
        }
        termuxAccepts = true;
        Map<String, String> kv = r.values();
        installedVersion = kv.getOrDefault("version", "");
        installedKnown = "1".equals(kv.get("installed"));
        String install = kv.getOrDefault("install", "");
        log = r.log();

        if ("1".equals(kv.get("installing"))) {
            setState(State.INSTALLING, "");
        } else if (install.startsWith("failed") || "running".equals(install)) {
            String where = install.startsWith("failed:") ? install.substring(7) : "";
            setState(State.INSTALL_FAILED, "running".equals(install)
                    ? "La instalación se interrumpió (¿se cerró Termux?)."
                    : "La instalación falló" + (where.isEmpty() ? "." : " en: " + where + "."));
        } else if (!installedKnown) {
            setState(State.NEED_INSTALL, "");
        } else if ("1".equals(kv.get("server"))) {
            io.execute(() -> {
                boolean up = isServerUp();
                ui.post(() -> {
                    if (up) setState(State.RUNNING, "");
                    else waitForServer();
                });
            });
        } else if (updateAvailable()) {
            setState(State.NEED_UPDATE, "");
        } else {
            setState(State.READY, "");
            if (!autoStarted && !userStopped) {
                autoStarted = true;
                startServer();
            }
        }
    }

    private boolean updateAvailable() {
        return !bundledVersion.isEmpty()
                && (installedVersion.isEmpty() || installedVersion.compareTo(bundledVersion) < 0);
    }

    // ---------------------------------------------------------------- acciones

    private void onPrimary() {
        switch (state) {
            case NEED_TERMUX:
            case TERMUX_INCOMPATIBLE:
                openExternal(Uri.parse(TERMUX_FDROID));
                break;
            case NEED_PERMISSION:
                requestRunPermission();
                break;
            case TERMUX_NOT_READY:
                openTermux();
                break;
            case NEED_ENABLE:
                ClipboardManager cm = getSystemService(ClipboardManager.class);
                cm.setPrimaryClip(ClipData.newPlainText("termux", ENABLE_CMD));
                Toast.makeText(this, "Comando copiado: en Termux mantén pulsado → Pegar → Enter",
                        Toast.LENGTH_LONG).show();
                openTermux();
                break;
            case NEED_INSTALL:
            case NEED_UPDATE:
            case INSTALL_FAILED:
                if (hasBundle()) installFromApk();
                else askPcUrl();
                break;
            case INSTALLING:
                openTermux();
                break;
            case READY:
            case START_FAILED:
                startServer();
                break;
            case RUNNING:
                showWeb();
                break;
            default:
                refresh();
        }
    }

    private void onAlt() {
        switch (state) {
            case NEED_TERMUX:
            case TERMUX_INCOMPATIBLE:
                openExternal(Uri.parse(TERMUX_GITHUB));
                break;
            case NEED_UPDATE:
                startServer();
                break;
            default:
                openTermux();
        }
    }

    private void requestRunPermission() {
        boolean asked = prefs().getBoolean(KEY_PERM_ASKED, false);
        if (asked && !shouldShowRequestPermissionRationale(TERMUX_PERMISSION)) {
            Toast.makeText(this, "Permisos → Permisos adicionales → «Ejecutar comandos en Termux» → Permitir",
                    Toast.LENGTH_LONG).show();
            openAppSettings(getPackageName());
            return;
        }
        prefs().edit().putBoolean(KEY_PERM_ASKED, true).apply();
        requestPermissions(new String[]{TERMUX_PERMISSION}, REQ_PERMISSION);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMISSION) refresh();
    }

    /** Pasa el paquete del APK a Termux por 127.0.0.1 (sin Download/ ni permiso de almacenamiento) y lanza el instalador. */
    private void installFromApk() {
        Map<String, String> routes = new HashMap<>();
        routes.put("bundle", BUNDLE_ASSET);
        routes.put("installer", INSTALLER_ASSET);
        AssetServer server;
        try {
            server = new AssetServer(getAssets(), routes);
        } catch (IOException e) {
            setState(State.INSTALL_FAILED, "No se pudo preparar la copia: " + e.getMessage());
            return;
        }
        long total = server.length("bundle");
        setState(State.COPYING, "Pasando el paquete a Termux…");
        Runnable progress = new Runnable() {
            @Override
            public void run() {
                if (state != State.COPYING) return;
                long mb = server.bytesSent.get() >> 20;
                setStatus("Pasando el paquete a Termux… " + mb + (total > 0 ? " / " + (total >> 20) : "") + " MB");
                ui.postDelayed(this, 500);
            }
        };
        ui.post(progress);
        String cmd = String.join("\n",
                "set -e",
                "P=\"$HOME/flash-pkg\"; mkdir -p \"$P\"",
                "command -v curl >/dev/null || pkg install -y curl >/dev/null 2>&1",
                "curl -fsS -o \"$P/termux-install.sh\" " + shellQuote(server.url("installer")),
                "rm -f \"$P/flash-android.tar.gz\"",
                "curl -fsS -o \"$P/flash-android.tar.gz.part\" " + shellQuote(server.url("bundle")),
                "mv -f \"$P/flash-android.tar.gz.part\" \"$P/flash-android.tar.gz\"",
                "echo \"size=$(wc -c < \"$P/flash-android.tar.gz\")\"",
                "echo FLASH_OK");
        termux(cmd, COPY_TIMEOUT_MS, r -> {
            server.close();
            ui.removeCallbacks(progress);
            long got = parseLong(r.values().get("size"));
            if (r.ok() && (total < 0 || got == total)) {
                launchInstaller("cd ~; BUNDLE=\"$HOME/flash-pkg/flash-android.tar.gz\" bash \"$HOME/flash-pkg/termux-install.sh\"; "
                        + BACK_TO_APP);
            } else {
                log = r.ok() ? "Copiados " + (got >> 20) + " de " + (total >> 20) + " MB" : r.describe();
                setState(State.INSTALL_FAILED, "No se pudo pasar el paquete a Termux (¿hay ~2 GB libres?).");
            }
        });
    }

    private void launchInstaller(String command) {
        userStopped = false;
        autoStarted = false;
        if (runInTermux(command, false)) {
            setState(State.INSTALLING, "");
            openTermux();
        }
    }

    private void askPcUrl() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setText(prefs().getString(KEY_PC_URL, "http://192.168.1."));
        input.setSelection(input.getText().length());
        LinearLayout box = new LinearLayout(this);
        box.setPadding(dp(20), dp(8), dp(20), 0);
        box.addView(input, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        new AlertDialog.Builder(this)
                .setTitle("Actualizar desde el PC")
                .setMessage("En el PC ejecuta android\\release-android.ps1 -Serve y escribe la dirección que muestra "
                        + "(misma Wi-Fi).")
                .setView(box)
                .setPositiveButton("Comprobar", (d, w) -> checkPc(input.getText().toString()))
                .setNegativeButton("Cancelar", null)
                .show();
    }

    private void checkPc(String raw) {
        String url = raw.trim().replaceAll("/+$", "");
        if (!URL_OK.matcher(url).matches()) {
            Toast.makeText(this, "Dirección no válida: " + url, Toast.LENGTH_LONG).show();
            return;
        }
        prefs().edit().putString(KEY_PC_URL, url).apply();
        setStatus("Consultando el PC " + url + "…");
        String cmd = String.join("\n",
                "command -v curl >/dev/null || pkg install -y curl >/dev/null 2>&1",
                "v=$(curl -fsS --max-time 8 " + shellQuote(url + "/VERSION") + ") || exit 1",
                "echo \"pc=$v\"",
                "echo FLASH_OK");
        termux(cmd, 30_000, r -> {
            if (!r.ok()) {
                setStatus("");
                new AlertDialog.Builder(this)
                        .setTitle("El PC no responde")
                        .setMessage(url + "\n\n¿Está corriendo release-android.ps1 -Serve, en la misma Wi-Fi y con el "
                                + "firewall permitiendo el puerto?\n\n" + r.describe())
                        .setPositiveButton("Reintentar", (d, w) -> askPcUrl())
                        .setNegativeButton("Cerrar", null)
                        .show();
                return;
            }
            String pcVersion = r.values().getOrDefault("pc", "").trim();
            setStatus("");
            new AlertDialog.Builder(this)
                    .setTitle("PC: v" + pcVersion)
                    .setMessage("Instalada: " + (installedKnown ? label(installedVersion) : "ninguna")
                            + "\nIncluida en el APK: " + label(bundledVersion)
                            + "\n\nActualizar conserva tu historial. Si cambian dependencias, Termux necesita internet.")
                    .setPositiveButton("Instalar desde el PC", (d, w) -> launchInstaller(String.join("\n",
                            "U=" + shellQuote(url) + "; P=\"$HOME/flash-pkg\"; mkdir -p \"$P\"; cd ~",
                            "command -v curl >/dev/null || pkg install -y curl",
                            "if curl -fL --retry 3 -o \"$P/termux-install.sh\" \"$U/termux-install.sh\"; then",
                            "  BUNDLE_URL=\"$U/flash-android.tar.gz\" bash \"$P/termux-install.sh\"",
                            "else",
                            "  echo \"failed:el PC no respondió ($U)\" > ~/.flash-install-state",
                            "  echo \"ERROR: el PC no respondió en $U\"",
                            "fi",
                            BACK_TO_APP)))
                    .setNeutralButton("Bajar APK nuevo", (d, w) -> openExternal(Uri.parse(url + "/FlashSignals.apk")))
                    .setNegativeButton("Cancelar", null)
                    .show();
        });
    }

    private void startServer() {
        userStopped = false;
        autoStarted = true;
        if (!runInTermux(START_CMD, true)) return;
        waitForServer();
    }

    private void stopServer() {
        userStopped = true;
        setState(State.CHECKING, "Deteniendo servidor…");
        termux(STOP_CMD, PROBE_TIMEOUT_MS, r -> {
            showSetup();
            refresh();
        });
    }

    // ---------------------------------------------------------------- arranque con seguimiento

    private void waitForServer() {
        if (state == State.STARTING) return;
        startedAt = SystemClock.elapsedRealtime();
        lastAliveCheck = 0;
        deadChecks = 0;
        log = "";
        setState(State.STARTING, "Arrancando…");
        ui.post(startTick);
    }

    private final Runnable startTick = new Runnable() {
        @Override
        public void run() {
            if (state != State.STARTING) return;
            io.execute(() -> {
                boolean up = isServerUp();
                ui.post(() -> onStartTick(up));
            });
        }
    };

    private void onStartTick(boolean up) {
        if (state != State.STARTING) return;
        int s = (int) ((SystemClock.elapsedRealtime() - startedAt) / 1000);
        if (up) {
            setState(State.RUNNING, "");
            showWeb();
            return;
        }
        if (s >= START_TIMEOUT_S) {
            failStart("El servidor no respondió en " + START_TIMEOUT_S + " s.", null);
            return;
        }
        String phase = s < 6 ? "Iniciando Ubuntu (proot)…"
                : s < 25 ? "Cargando servidor Node y base de datos…"
                : s < 50 ? "Casi listo (el primer arranque tras instalar tarda más)…"
                : "Tarda más de lo normal…";
        setStatus(phase + " " + s + " s / " + START_TIMEOUT_S);
        if (s >= 10 && s - lastAliveCheck >= 5) {
            lastAliveCheck = s;
            termux(ALIVE_CMD, 8000, r -> {
                if (state != State.STARTING || !r.ok()) return;
                if ("1".equals(r.values().get("alive"))) {
                    deadChecks = 0;
                } else if (++deadChecks >= 2) {
                    failStart("El servidor se cerró al arrancar.", r.log());
                }
            });
        }
        ui.postDelayed(startTick, 1000);
    }

    private void failStart(String msg, String serverLog) {
        if (serverLog != null) {
            log = serverLog;
            setState(State.START_FAILED, msg);
            return;
        }
        setState(State.START_FAILED, msg);
        termux(ALIVE_CMD, 8000, r -> {
            if (state != State.START_FAILED) return;
            log = r.ok() ? r.log() : r.describe();
            render();
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

    /** La versión de Google Play no trae RunCommandService. */
    private boolean termuxSupportsRunCommand() {
        try {
            getPackageManager().getServiceInfo(new ComponentName(TERMUX_PKG, TERMUX_SERVICE), 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private boolean hasRunPermission() {
        return checkSelfPermission(TERMUX_PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean termuxBatteryOk() {
        PowerManager pm = getSystemService(PowerManager.class);
        return pm != null && pm.isIgnoringBatteryOptimizations(TERMUX_PKG);
    }

    private Intent runIntent(String command, boolean background) {
        Intent intent = new Intent("com.termux.RUN_COMMAND");
        intent.setClassName(TERMUX_PKG, TERMUX_SERVICE);
        intent.putExtra("com.termux.RUN_COMMAND_PATH", TERMUX_BASH);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[]{"-c", command});
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", background);
        intent.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", SESSION_NEW_NO_ACTIVITY);
        return intent;
    }

    private boolean runInTermux(String command, boolean background) {
        try {
            startForegroundService(runIntent(command, background));
            return true;
        } catch (RuntimeException e) {
            log = String.valueOf(e.getMessage());
            setState(State.TERMUX_NOT_READY, "Termux rechazó el comando.");
            return false;
        }
    }

    /** Comando en segundo plano con resultado (stdout/err) vía PendingIntent; null-safe y con timeout. */
    private void termux(String command, long timeoutMs, Consumer<TermuxResult> callback) {
        int id = TermuxResultReceiver.register(b -> callback.accept(TermuxResult.of(b)));
        Intent reply = new Intent(this, TermuxResultReceiver.class).putExtra(TermuxResultReceiver.EXTRA_ID, id);
        int flags = PendingIntent.FLAG_ONE_SHOT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
        Intent intent = runIntent(command, true);
        intent.putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", PendingIntent.getBroadcast(this, id, reply, flags));
        try {
            startForegroundService(intent);
        } catch (RuntimeException e) {
            Consumer<Bundle> cb = TermuxResultReceiver.take(id);
            if (cb != null) {
                Bundle b = new Bundle();
                b.putString("errmsg", String.valueOf(e.getMessage()));
                cb.accept(b);
            }
            return;
        }
        ui.postDelayed(() -> {
            Consumer<Bundle> cb = TermuxResultReceiver.take(id);
            if (cb != null) {
                Bundle b = new Bundle();
                b.putBoolean(TermuxResult.TIMEOUT, true);
                cb.accept(b);
            }
        }, timeoutMs);
    }

    private void openTermux() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(TERMUX_PKG);
        if (launch != null) startActivity(launch);
    }

    private void openAppSettings(String pkg) {
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", pkg, null)));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Abre Ajustes → Apps → " + pkg, Toast.LENGTH_LONG).show();
        }
    }

    private static String shellQuote(String s) {
        return "'" + s.replace("'", "'\\''") + "'";
    }

    private static final class TermuxResult {
        static final String TIMEOUT = "flash_timeout";
        private static final String LOG_MARK = "--log--";

        final boolean timedOut;
        final String stdout;
        final String stderr;
        final String errmsg;
        final int exitCode;

        private TermuxResult(Bundle b) {
            timedOut = b.getBoolean(TIMEOUT, false);
            stdout = nz(b.getString("stdout"));
            stderr = nz(b.getString("stderr"));
            errmsg = nz(b.getString("errmsg"));
            exitCode = b.getInt("exitCode", -1);
        }

        static TermuxResult of(Bundle b) {
            return new TermuxResult(b);
        }

        boolean ok() {
            return !timedOut && stdout.contains("FLASH_OK");
        }

        Map<String, String> values() {
            Map<String, String> kv = new HashMap<>();
            int end = stdout.indexOf(LOG_MARK);
            for (String line : (end >= 0 ? stdout.substring(0, end) : stdout).split("\n")) {
                int eq = line.indexOf('=');
                if (eq > 0) kv.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
            }
            return kv;
        }

        String log() {
            int i = stdout.indexOf(LOG_MARK);
            return i >= 0 ? stdout.substring(i + LOG_MARK.length()).trim() : "";
        }

        String describe() {
            if (timedOut) return "Termux no respondió a tiempo.";
            if (!errmsg.isEmpty()) return errmsg.trim();
            if (!stderr.isEmpty()) return stderr.trim();
            return "código de salida " + exitCode;
        }

        private static String nz(String s) {
            return s == null ? "" : s;
        }
    }

    // ---------------------------------------------------------------- utilidades

    private boolean hasBundle() {
        if (bundlePresent == null) {
            try {
                bundlePresent = Arrays.asList(getAssets().list("")).containsAll(Arrays.asList(BUNDLE_ASSET, INSTALLER_ASSET));
            } catch (IOException e) {
                bundlePresent = false;
            }
        }
        return bundlePresent;
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[256];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (IOException e) {
            return "";
        }
    }

    private void rememberPcUrl(Intent intent) {
        String url = intent == null ? null : intent.getStringExtra(KEY_PC_URL);
        if (url != null && URL_OK.matcher(url.trim()).matches()) {
            prefs().edit().putString(KEY_PC_URL, url.trim()).apply();
        }
    }

    private static long parseLong(String s) {
        try {
            return s == null ? -1 : Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String label(String version) {
        return version == null || version.isEmpty() ? "desconocida" : "v" + version;
    }

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

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    // ---------------------------------------------------------------- WebView

    private boolean webVisible() {
        return web != null && web.getParent() != null;
    }

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
            // Descargas dentro de la app (carpeta Descargas): puente JS para blob:/base64 y listener para
            // http(s) locales con Content-Disposition: attachment, data: y blob:. Ver DownloadBridge.
            downloads = new DownloadBridge(this, web);
            web.addJavascriptInterface(downloads, DownloadBridge.JS_NAME);
            web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
                if (!downloads.handle(url, disposition, mime)) openExternal(Uri.parse(url));
            });
            web.loadUrl(APP_URL);
        }
        setContentView(web);
    }

    private void showSetup() {
        setContentView(setupView);
        render();
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
        if (webVisible()) {
            if (web.canGoBack()) {
                web.goBack();
            } else {
                showSetup();
            }
            return;
        }
        super.onBackPressed();
    }

    // ---------------------------------------------------------------- UI del asistente

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

        LinearLayout checks = new LinearLayout(this);
        checks.setOrientation(LinearLayout.VERTICAL);
        checks.setPadding(dp(14), dp(10), dp(14), dp(12));
        checks.setBackground(rounded(PANEL));
        chkTermux = text("", 14, MUTED);
        chkPermission = text("", 14, MUTED);
        chkEnabled = text("", 14, MUTED);
        chkInstalled = text("", 14, MUTED);
        chkBattery = text("", 14, MUTED);
        for (TextView t : new TextView[]{chkTermux, chkPermission, chkEnabled, chkInstalled, chkBattery}) {
            checks.addView(t);
        }
        col.addView(checks, margins(dp(18)));

        btnPrimary = new Button(this);
        btnPrimary.setAllCaps(false);
        btnPrimary.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        btnPrimary.setTypeface(Typeface.DEFAULT_BOLD);
        btnPrimary.setTextColor(BG);
        btnPrimary.setBackground(rounded(GOLD));
        btnPrimary.setPadding(dp(12), dp(14), dp(12), dp(14));
        btnPrimary.setOnClickListener(v -> onPrimary());
        col.addView(btnPrimary, margins(dp(20)));

        help = text("", 13, MUTED);
        col.addView(help);

        status = text("", 14, Color.WHITE);
        status.setPadding(0, dp(12), 0, 0);
        col.addView(status);

        logView = text("", 11, MUTED);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextIsSelectable(true);
        logView.setBackground(rounded(PANEL));
        logView.setPadding(dp(10), dp(8), dp(10), dp(8));
        col.addView(logView, margins(dp(8)));

        btnAlt = secondary(col, "", v -> onAlt());
        btnBattery = secondary(col, "Quitar restricción de batería a Termux", v -> {
            Toast.makeText(this, "Batería → Sin restricciones", Toast.LENGTH_LONG).show();
            openAppSettings(TERMUX_PKG);
        });
        btnPc = secondary(col, "Actualizar desde el PC (Wi-Fi)", v -> askPcUrl());
        btnReinstall = secondary(col, "", v -> installFromApk());
        btnStop = secondary(col, "Detener servidor", v -> stopServer());
        btnRecheck = secondary(col, "Volver a comprobar", v -> refresh());

        col.addView(text("Android 12+: si el servidor se cierra solo, quita la restricción de batería a Termux "
                + "(botón de arriba) o ejecuta android\\setup-phone-adb.ps1 desde el PC.", 12, MUTED), margins(dp(18)));
        render();
        return scroll;
    }

    private void render() {
        if (btnPrimary == null) return;
        boolean termux = termuxInstalled();
        boolean compatible = termux && termuxSupportsRunCommand();
        boolean perm = compatible && hasRunPermission();
        boolean battery = termux && termuxBatteryOk();

        check(chkTermux, compatible, termux && !compatible ? "Termux de Play Store: incompatible" : "Termux (F-Droid / GitHub)");
        check(chkPermission, perm, "Permiso «Ejecutar comandos en Termux»");
        check(chkEnabled, termuxAccepts, "Termux acepta comandos de la app");
        String inst = installedKnown ? "Flash Signals instalado (" + label(installedVersion) + ")" : "Flash Signals instalado";
        if (installedKnown && updateAvailable()) inst += " · nueva " + label(bundledVersion);
        check(chkInstalled, installedKnown && !updateAvailable(), inst);
        chkBattery.setText((battery ? "✓ " : "○ ") + "Batería de Termux sin restricciones (recomendado)");
        chkBattery.setTextColor(battery ? OK_GREEN : MUTED);

        String primary;
        String hint;
        boolean enabled = true;
        String alt = null;
        switch (state) {
            case NEED_TERMUX:
                primary = "Instalar Termux";
                hint = "Termux ejecuta Node y Python en el teléfono. Instálalo desde F-Droid o GitHub (no Play Store), "
                        + "ábrelo una vez y vuelve aquí.";
                alt = "Descargar Termux de GitHub";
                break;
            case TERMUX_INCOMPATIBLE:
                primary = "Instalar Termux de F-Droid";
                hint = "La versión de Play Store no deja que otras apps la usen. Desinstálala e instala la de F-Droid o GitHub.";
                alt = "Descargar Termux de GitHub";
                break;
            case NEED_PERMISSION:
                primary = "Permitir usar Termux";
                hint = "Android pedirá el permiso «Ejecutar comandos en Termux». Pulsa Permitir.";
                break;
            case TERMUX_NOT_READY:
                primary = "Abrir Termux";
                hint = "Termux aún no está listo. Ábrelo, espera a que termine de prepararse y vuelve aquí.";
                break;
            case NEED_ENABLE:
                primary = "Copiar comando y abrir Termux";
                hint = "Solo una vez: en Termux mantén pulsado → Pegar → Enter. Al volver aquí se comprueba solo.";
                break;
            case NEED_INSTALL:
                primary = !hasBundle() ? "Instalar desde el PC (Wi-Fi)"
                        : bundledVersion.isEmpty() ? "Instalar Flash Signals" : "Instalar Flash Signals " + label(bundledVersion);
                hint = "Se instala en Termux (20–40 min la primera vez, necesita internet). Puedes seguir el progreso en Termux; "
                        + "al terminar vuelve aquí y arrancará solo.";
                break;
            case NEED_UPDATE:
                primary = "Actualizar a " + label(bundledVersion);
                hint = "Instalada: " + label(installedVersion) + ". Actualizar conserva historial y live/; solo descarga "
                        + "dependencias si cambiaron.";
                alt = "Abrir sin actualizar";
                break;
            case COPYING:
                primary = "Copiando paquete…";
                hint = "No cierres la app mientras se copia (unos segundos).";
                enabled = false;
                break;
            case INSTALLING:
                primary = "Ver progreso en Termux";
                hint = "La instalación sigue en Termux. Al terminar vuelve aquí: se comprobará y arrancará solo.";
                break;
            case INSTALL_FAILED:
                primary = hasBundle() ? "Reintentar instalación" : "Reintentar desde el PC";
                hint = "Revisa la conexión a internet y el registro de abajo.";
                alt = "Abrir Termux";
                break;
            case READY:
                primary = "Iniciar y abrir";
                hint = "Arranca el servidor en segundo plano y abre la interfaz.";
                break;
            case STARTING:
                primary = "Arrancando…";
                hint = "Se abrirá sola en cuanto el servidor responda.";
                enabled = false;
                break;
            case START_FAILED:
                primary = "Reintentar";
                hint = "Últimas líneas del registro del servidor (~/flash-server.log):";
                alt = "Abrir Termux";
                break;
            case RUNNING:
                primary = "Abrir Flash Signals";
                hint = "El servidor está funcionando.";
                break;
            default:
                primary = "Comprobando…";
                hint = "";
                enabled = false;
        }
        btnPrimary.setText(primary);
        btnPrimary.setEnabled(enabled);
        btnPrimary.setAlpha(enabled ? 1f : 0.6f);
        help.setText(detail.isEmpty() ? hint : detail + "\n" + hint);
        help.setTextColor(state == State.INSTALL_FAILED || state == State.START_FAILED ? WARN : MUTED);

        boolean showLog = !log.isEmpty() && (state == State.INSTALL_FAILED || state == State.START_FAILED
                || state == State.TERMUX_NOT_READY);
        logView.setText(log);
        logView.setVisibility(showLog ? View.VISIBLE : View.GONE);

        boolean idle = state != State.COPYING && state != State.CHECKING;
        show(btnAlt, alt != null);
        if (alt != null) btnAlt.setText(alt);
        show(btnBattery, termux && !battery);
        show(btnPc, termuxAccepts && idle && state != State.INSTALLING);
        boolean reinstall = hasBundle() && installedKnown && idle
                && (state == State.READY || state == State.RUNNING || state == State.START_FAILED);
        show(btnReinstall, reinstall);
        btnReinstall.setText(bundledVersion.isEmpty() ? "Reinstalar paquete del APK"
                : "Reinstalar paquete del APK (" + label(bundledVersion) + ")");
        show(btnStop, installedKnown && (state == State.RUNNING || state == State.STARTING || state == State.START_FAILED
                || state == State.READY));
        show(btnRecheck, idle && state != State.STARTING);
    }

    private void setState(State s, String message) {
        state = s;
        detail = s == State.CHECKING || s == State.COPYING || s == State.STARTING ? "" : message;
        if (status != null) {
            status.setText(s == State.CHECKING || s == State.COPYING || s == State.STARTING ? message : "");
        }
        render();
    }

    private void setStatus(String s) {
        status.setText(s);
    }

    private void check(TextView t, boolean ok, String label) {
        t.setText((ok ? "✓ " : "○ ") + label);
        t.setTextColor(ok ? OK_GREEN : Color.WHITE);
    }

    private static void show(View v, boolean visible) {
        v.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    private Button secondary(LinearLayout col, String label, View.OnClickListener onClick) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setGravity(Gravity.CENTER);
        b.setOnClickListener(onClick);
        col.addView(b, margins(dp(8)));
        return b;
    }

    private LinearLayout.LayoutParams margins(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }

    private GradientDrawable rounded(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(10));
        return d;
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
}
