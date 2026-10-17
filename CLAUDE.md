# CLAUDE.md — Flash Signals Angular

Contexto operativo para Claude (y agentes) al modificar este repo.

## Proyecto

UI local **Angular 19** + API **Express** (`server/index.js`) que orquesta señales **BTC / US30** del stack **Cursor Trading** (no se copia; se invoca).

| Ruta | Rol |
|------|-----|
| `D:\Danilo\Trading\flash-signals-angular` | Esta app |
| `D:\Danilo\Trading\Cursor Trading` | Stack de señales (`CURSOR_TRADING_ROOT`) |

## Reglas duras

1. **No inventar señales** ni “rellenar” planes/scores/charts si el runner falla: mostrar el error real.
2. **No Cursor AI** como generador de señales; solo spawn de `.ps1` → Python del trading stack.
3. PNG de gráfico **solo** vía API (`/api/signals/chart`).
4. API pensada para **localhost** (`BIND_HOST=127.0.0.1` por defecto). No publicar a Internet.
5. **No commit** de secretos (`.env`, tokens, credenciales).
6. Branding: *Flash Signals · fuego y sombra*, crédito **Danilo Chaverra**, `src/assets/logo.png`.
7. **Fuente de datos:** `server/data-source.js` resuelve `yahoo|mt5|auto`. Defecto `yahoo`. Android/Termux, cabecera `X-FS-Client: small` y peticiones sin admin quedan siempre en modo Yahoo (aunque `data/mt5-settings.json` diga `mt5`): no se abre el puente. El desplegable de `/configuracion` solo lo ve un admin (`AuthService.isAdmin()`): Solo Yahoo o MT5; MT5 aplica en el escritorio de esa sesión. APK: `android/start.sh` fija `FS_DATA_SOURCE=yahoo`. En ese modo `mt5.brokerFeedEnv()` devuelve solo `FS_DATA_SOURCE=yahoo` (nunca `FS_MT5_*`). Python (`broker_feed.yahoo_only()`) no llama a MT5. Si Yahoo falla, velas en orden Binance → OKX → Stooq (`app/models/free_candles.py`); US30 no se mapea a un par cripto. ATR usa la misma cadena (`server/yahoo-candles.js` + `server/candle-fallback.js`). El VIX sigue en `server/vix-source.js`. El gráfico nombra la fuente que respondió («Binance (Yahoo falló)», «OKX», «Stooq»). Todo código nuevo que lea velas debe respetar el modo; el móvil corre su **propia copia** del código (reempaquetar y publicar con un solo comando: `android\release-android.ps1`, que ya llama a `pack-for-android.ps1`; `-SkipPack` reutiliza el último paquete).

## Stack técnico

- Angular 19 (`src/app/pages/historial` = página `/senales`, `src/app/shared/signal-run-form.component.ts`, `src/app/services/signals-api.service.ts`) — `ng serve` en **:4400**
- Express 5 CommonJS en `server/` (deps en `server/package.json`) — API en **:3847**
- Scripts host: `run-api.ps1`, `run-local-web.ps1`, `run-both.ps1`, `run-apk-web.ps1` (simula el APK: `-DataSource yahoo`, sin MT5)
- Cursor/VS Code: `.vscode/launch.json` compound **API + Web** (F5, hot reload)
- Docker: `Dockerfile.web`, `Dockerfile.api`, `docker-compose.yml`, `run-docker.ps1`, `run-docker-arm.ps1` (UI nginx **:8080**)

## UI

- Tabs: **Modo Trader** (técnico) · **Modo Inversor** (simple) · **Cómo usar**
- Ruta **`/senales`**: formulario de corrida + historial de corridas (caja local SQLite) en una sola página; `/historial` redirige aquí
- Ruta **`/wiki`** (alias `/artefactos`): wiki de artefactos Cursor AI en `docs/Artifacts`
- Cards colapsables compartidas en `src/app/shared/signal-report-viewer`
- **Descargas (navegador y APK):** nunca `<a download>`/`doc.save` sueltos. Usar `src/app/shared/file-download.ts` (`saveBlob`/`saveFromUrl`) o `DownloadService` (aviso global en español). En el APK el WebView no guarda `blob:`; `android/.../DownloadBridge.java` expone `window.AndroidDownloader.saveBase64(nombre, mime, b64)` y guarda en Descargas (MediaStore). Cambios en Java requieren APK nuevo (`release-android.ps1`). El visor de imágenes (`app-image-viewer`) trae botón «Descargar»

## Historial (hive box)

- SQLite embebido en `data/signals-history.sqlite` (gitignore). Schema en `server/db/`.
- Motor: `better-sqlite3` (fallback `sql.js`). No es Apache Hive ni DB remota.
- Tras cada job de `POST /api/signals/run` (done/error) se persiste un snapshot real.
- Endpoints: `GET/DELETE /api/history`, `GET/DELETE /api/history/:id`.

## Wiki / artefactos

- Carpeta: `docs/Artifacts/` (README de ejemplo versionado).
- Escaneo fresco: `GET /api/artifacts` y `POST /api/artifacts/scan`.
- Lectura segura: `GET /api/artifacts/item?path=` y `GET /api/artifacts/raw?path=` (solo bajo Artifacts; sin `..`).
- UI: sidebar + preview (MD sanitizado, HTML iframe sandbox, imágenes, PDF).

## Endpoints clave

- `GET /api/health` — incluye `signalsRunnable` / `platform`
- `POST /api/signals/run` — una job a la vez; persiste en hive box al completar
- `GET /api/signals/status`, `latest`, `chart`
- `GET /api/signals/events` — SSE del job en curso (`snapshot` al conectar, `job:started|progress|finished|failed`, `ping` cada 15 s). UI: `SignalJobService` (root) sobrevive a F5 / cambio de ruta
- Imágenes (`/api/signals/chart`, `/api/signals/card`, `/api/signals/macd-chart`, `/api/history/:id/result-image`, `/api/signals/macd-quant/history/:id/chart`, `/api/artifacts/raw`) aceptan `?download=1[&filename=]` → `Content-Disposition: attachment` (`server/download-headers.js`; el nombre se sanea y nunca elige el archivo)
- **Tarjeta/póster de la señal:** el canvas del navegador (`signal-share-poster.ts`) carga el PNG con `shared/chart-image.ts` (fetch same-origin → blob → decode; si falla, dice por qué en `chartWarning`). `POST /api/signals/card` (`server/signal-card.js` → Python `app/views/signal_card.py`, Pillow) compone la misma tarjeta en el servidor con el PNG de `live/`; el APK (WebView) descarga esa y, si el canvas se quedó sin velas, el marco muestra esa imagen. El job y `/api/signals/latest` llevan `chartError` (motivo en español) cuando no hay PNG. El motor que corre el PC y el que se empaqueta para el móvil es `data/cursor-trading` (ediciones locales se respetan en `pack-for-android.ps1`; `-RefreshEngine` las pisa con GitHub)
- `GET /api/zentinel`
- `GET|DELETE /api/history` (+ `/:id`)
- `GET /api/artifacts`, `POST /api/artifacts/scan`, `GET /api/artifacts/item|raw?path=`

## Docker (ser honesto)

- **Objetivo principal:** servir la UI **sin** instalar Node/Angular en el host.
- Contenedor **Linux** + API Node: health y lectura de `live/` (si hay volumen) OK.
- **Ejecutar señales reales** suele requerir API en **host Windows**: `.\run-api.ps1` + `.\run-docker.ps1 -HostApi`.
- ARM64: `.\run-docker-arm.ps1` o compose con `platform: linux/arm64` / buildx multi-arch.

## Arranque rápido

```powershell
# Host con Node
.\run-api.ps1
.\run-local-web.ps1
# Simular el APK en la web de escritorio (Yahoo, sin puentes ni terminal MT5):
.\run-apk-web.ps1

# Sin Node: Docker UI (+ API mock/limitada) o híbrido
.\run-docker.ps1
.\run-docker.ps1 -HostApi   # UI Docker + API Windows
.\run-docker-arm.ps1        # ARM64
```

`run-apk-web.ps1` abre `http://localhost:4400` y pasa `-DataSource yahoo` a la API (`FS_DATA_SOURCE=yahoo`). No emula `window.AndroidDownloader`: Descargar sigue siendo la descarga del navegador.

## Al cambiar código

- Preferir cambios mínimos y alineados con Express + Angular 19 existentes.
- No añadir Super High / lectura live de TradingView salvo pedido explícito.
- Si tocas Docker, puertos o límites de señales, actualiza `README.md`.
- Idioma de UI/mensajes: español (usuario Danilo).
