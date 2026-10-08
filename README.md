# Flash Signals Angular

UI local (Angular 19 + API Express) para orquestar señales **BTC / US30** del stack real **Cursor Trading**.

- **No usa Cursor AI** ni inventa señales: solo invoca los `.ps1` del repo trading y muestra el resultado (o el error real).
- Branding *fuego y sombra*, crédito **Danilo Chaverra**, logo en `src/assets/logo.png`.

## Rutas

| Qué | Ruta |
|-----|------|
| Esta app | `D:\Danilo\Trading\flash-signals-angular` |
| Stack de señales (no se copia; se invoca) | `D:\Danilo\Trading\Cursor Trading` |

## Requisitos

### Con Node local

- **Node.js** 20+ (LTS recomendado; Node 23 suele funcionar con avisos)
- **npm**
- **Python** del mismo entorno que usas con Cursor Trading (`requirements*.txt` del stack)
- **PowerShell** (Windows)
- Variable **`CURSOR_TRADING_ROOT`** apuntando a la raíz del repo trading (default abajo)

### Sin Node/Angular: Docker

- **Docker Desktop** (Windows/macOS/Linux) con Compose v2
- Para **señales reales**: PowerShell + Python + stack Cursor Trading en el **host Windows** (ver sección Docker)

## Instalación

```powershell
cd "D:\Danilo\Trading\flash-signals-angular"
npm install --legacy-peer-deps

cd server
npm install
cd ..
```

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `CURSOR_TRADING_ROOT` | `D:\Danilo\Trading\Cursor Trading` | Raíz del repo de señales |
| `PORT` | `3847` | Puerto de la API |
| `BIND_HOST` | `127.0.0.1` | Host de listen (solo loopback por defecto; Docker API usa `0.0.0.0`) |
| `CORS_ORIGINS` | _(vacío)_ | Orígenes extra CSV para CORS (p.ej. `http://localhost:8080`) |
| `WEB_PORT` | `8080` | Puerto host del contenedor web |
| `API_PORT` | `3847` | Puerto host del contenedor API |

```powershell
$env:CURSOR_TRADING_ROOT = "D:\Danilo\Trading\Cursor Trading"
$env:PORT = "3847"
```

## Calidad / SonarCloud

Ver [docs/QUALITY.md](docs/QUALITY.md). Resumen: crea el proyecto en SonarCloud, añade el secreto GitHub `SONAR_TOKEN`, y el workflow `.github/workflows/sonarcloud.yml` hará el análisis.

## Arranque

### Recomendado — scripts PowerShell (con Node)

Dos terminales desde la carpeta del proyecto:

```powershell
cd "D:\Danilo\Trading\flash-signals-angular"

# Terminal 1 — API Express → http://localhost:3847
.\run-api.ps1

# Terminal 2 — Angular → http://localhost:4400
.\run-local-web.ps1
```

Los scripts cambian al directorio del proyecto, instalan deps si faltan, y `run-api.ps1` define `CURSOR_TRADING_ROOT` si no está seteado.

También puedes usar **F5** en Cursor/VS Code con la compound `API + Web` (`.vscode/launch.json`).

| Servicio | Puerto | URL |
|----------|--------|-----|
| API | **3847** | http://localhost:3847 |
| Web (Angular + proxy `/api`) | **4400** | http://localhost:4400 |

Prueba rápida:

```powershell
curl http://localhost:3847/api/health
```

Si PowerShell bloquea la ejecución:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# o solo esta sesión:
powershell -ExecutionPolicy Bypass -File .\run-api.ps1
```

### Manual / ambos a la vez

```powershell
$env:CURSOR_TRADING_ROOT = "D:\Danilo\Trading\Cursor Trading"
npm run api       # terminal 1
npm start         # terminal 2

# opcional (concurrently):
npm run start:all
```

## Sin Node/Angular: Docker

Docker sirve para **correr la UI** sin instalar Node/Angular en el host.

**Sé honesto con el pipeline:** los `.ps1` de Cursor Trading + Python viven en **Windows**. Un contenedor Linux con Node **no** spawnea `powershell.exe` de forma fiable. Por eso:

| Modo | Comando | Qué hace | Señales reales |
|------|---------|----------|----------------|
| **Híbrido (recomendado)** | `.\run-api.ps1` + `.\run-docker.ps1 -HostApi` | API en host Windows; Docker solo UI (nginx → `host.docker.internal:3847`) | Sí |
| Full compose | `.\run-docker.ps1` | `api` + `web` en Docker; volumen trading → `/trading` | No (health/latest/chart sí, si hay volumen); `POST /run` responde 503 |
| ARM64 | `.\run-docker-arm.ps1` | Igual que arriba con `platform: linux/arm64` | Igual que el modo elegido |

### Scripts

```powershell
cd "D:\Danilo\Trading\flash-signals-angular"

# UI + API en Docker (desarrollo UI / health; señales limitadas)
.\run-docker.ps1

# Señales reales: API Windows + UI Docker
.\run-api.ps1                  # terminal 1
.\run-docker.ps1 -HostApi      # terminal 2 → http://localhost:8080

# ARM64 (Apple Silicon / Windows ARM / buildx)
.\run-docker-arm.ps1
.\run-docker-arm.ps1 -HostApi

# Bajar
.\run-docker.ps1 -Down
```

| Servicio | Puerto host | URL |
|----------|-------------|-----|
| Web (nginx) | **8080** | http://localhost:8080 |
| API (compose full) | **3847** | http://localhost:3847/api/health |

Archivos: `Dockerfile.web` (multi-stage Angular→nginx), `Dockerfile.api` (Node Express), `docker-compose.yml`, `docker-compose.host-api.yml`, `docker-compose.arm.yml`, `docker/nginx*.conf`.

### ARM64 / multi-arch

```powershell
# Vía script (platform linux/arm64 en compose)
.\run-docker-arm.ps1

# buildx multi-arch (opcional, avanzado)
docker buildx create --name flash-signals --use
docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile.web -t flash-signals-web:multi .
docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile.api -t flash-signals-api:multi .
```

En `docker-compose.arm.yml` se fija `platform: linux/arm64` para los servicios.

## Android (Termux + Ubuntu proot)

Corre API + UI + pipeline Python en el teléfono, sin servidor de pago. Las señales usan
`Cursor Trading/scripts/analyze/analyze.sh` (equivalente bash de los `.ps1`). MT5 no está disponible (solo Windows).

1. **PC** (con la API detenida): `.\android\pack-for-android.ps1` → genera `android\out\flash-android.tar.gz` y `termux-install.sh`.
2. Copia ambos por USB a `Download/` del teléfono.
3. Instala **Termux** desde F-Droid o GitHub (no Play Store) y ejecuta:
   `bash /sdcard/Download/termux-install.sh` (requiere internet la primera vez: apt, pip, npm).
4. Arranca con `~/flash-start.sh` y abre `http://localhost:3847`.

**APK (recomendado):** `.\android\build-apk.ps1` genera `android\out\FlashSignals.apk` con el paquete embebido.
La app instala vía Termux (`RUN_COMMAND`), arranca el servidor y muestra la UI en un WebView. Requiere Termux (F-Droid) y,
una vez, pegar en Termux `allow-external-apps = true` (la app copia el comando). Guía: `docs/Artifacts/2026-10-08-android-instalacion-termux.html`.

Actualizar: repite 1–3; se conservan `data/` (historial) y `live/`. `--fresh` reinstala desde cero.
Opciones: `SKIP_NEURAL=1` (sin torch), `WITH_OCR=1` (onnxruntime + rapidocr).
En Android 14+ activa *Opciones de desarrollador → Desactivar restricciones de procesos secundarios* y quita Termux de la optimización de batería.

| Variable | Uso |
|----------|-----|
| `SIGNAL_RUNNER` | `powershell` (default Windows) · `bash` (Android/Linux) · `none` (default resto: 503 en `/run`) |
| `SERVE_WEB=1` | La API sirve `dist/` en el mismo puerto (sin `ng serve`) |

## Contexto para agentes (Cursor / Claude)

| Recurso | Ubicación |
|---------|-----------|
| Reglas Cursor | [`.cursor/rules/flash-signals.mdc`](.cursor/rules/flash-signals.mdc) |
| Contexto Claude | [`CLAUDE.md`](CLAUDE.md) |

Resumen para agentes:

- Arquitectura UI **Trader / Inversor / Cómo usar**; no inventar señales.
- Gráficos PNG solo vía API; API localhost; branding Danilo / fuego y sombra.
- No commit de secretos; stack Express + Angular 19.
- Docker = UI sin Node; pipeline PowerShell→Python suele necesitar `run-api.ps1` en Windows.

## Tabs de la UI

| Tab / ruta | Qué muestra |
|------------|-------------|
| **Modo Trader** | Vista técnica: veredicto, plan, setup, scores, checklists, gráfico |
| **Modo Inversor** | Vista simplificada: decisión, plan, riesgo y scores en lenguaje claro |
| **Cómo usar** | Guía rápida (visible sin haber corrido una señal) |
| **Señales** (`/senales`) | Una sola página: formulario «Configurar corrida» + estado del job arriba y, debajo, el historial de corridas de la **caja local** SQLite (`/historial` redirige aquí) |
| **Wiki** (`/wiki`) | Artefactos Cursor AI en `docs/Artifacts` (MD/HTML/IMG/PDF) |

## Historial local (hive box / embedded store)

No usa Apache Hive ni Postgres/MySQL/cloud. La API guarda un **snapshot** de cada job completado en SQLite embebido:

| Pieza | Ubicación |
|-------|-----------|
| Archivo DB | `data/signals-history.sqlite` (gitignored) |
| Schema / migraciones | `server/db/schema.sql`, `server/db/migrations/` |
| Motor | `better-sqlite3` (fallback `sql.js` si falla el nativo en Windows) |

Solo se persiste lo que produjo el pipeline real (market, tier, flags, timestamps, veredicto, summary, paths md/png, status/error).

Endpoints:

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/history?page=1&pageSize=20&market=btc` | Lista paginada (newest first) |
| `GET` | `/api/history/:id` | Detalle + summary |
| `DELETE` | `/api/history/:id` | Borrar una entrada |
| `DELETE` | `/api/history` | Limpiar todo (la UI pide confirmación) |

## Wiki de artefactos (`docs/Artifacts`)

Carpeta para dejar artefactos de **Cursor AI** (notas, HTML, PNG, PDF…). La UI **Wiki** (`/wiki`, alias `/artefactos`) los lista y previsualiza.

| Pieza | Detalle |
|-------|---------|
| Carpeta | `docs/Artifacts/` (crear si falta; hay `README.md` de ejemplo) |
| Escaneo | Fresco en cada `GET /api/artifacts` + botón «Actualizar / Escanear» |
| Seguridad | Solo paths bajo Artifacts; `..` bloqueado; API en localhost |

Cómo añadir: copia el archivo a `docs/Artifacts` (o subcarpeta) → abre `/wiki` → **Actualizar / Escanear**.

## Features UI

- **Cards colapsables** (`<details>`) para veredicto, plan, setup, scores, checklists, gráfico, etc. (compartidas vía `app-signal-report-viewer`)
- **Gráfico PNG** vía `GET /api/signals/chart?market=btc|us30` (abre en pestaña nueva desde la card «Gráfico»)
- **Crédito** en el header: *Creado por: Danilo Chaverra*
- **Branding** *Flash Signals · fuego y sombra* + logo (`assets/logo.png`, también favicon)
- Formulario: mercado BTC/US30, tiers Context / Light / High / History, flags (Bullish/Bearish, Break/Reverse, ML, Neural, Ilustrate, Advanced, Entry en High)
- Recarga del último reporte live sin volver a ejecutar
- **Historial**: filtro BTC/US30, fechas relativas+absolutas, badges de veredicto, drawer de detalle con Modo Trader/Inversor
- **Wiki** (`/wiki`): sidebar de artefactos + preview (Markdown sanitizado, HTML en iframe sandbox, imágenes, PDF)

## Endpoints API principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/health` | Estado, `CURSOR_TRADING_ROOT`, job, `signalsRunnable` / plataforma |
| `POST` | `/api/signals/run` | Lanza el `.ps1` correspondiente (una corrida a la vez; 503 si API no-Windows); al completar, persiste en hive box |
| `GET` | `/api/signals/status` | Job actual (logs / done / error) |
| `GET` | `/api/signals/latest?market=btc&tier=high` | Último `.md` parseado en `live/` |
| `GET` | `/api/signals/chart?market=btc` | PNG anotado (`btc_m5_chart_annotated.png` / US30) |
| `GET` | `/api/zentinel?market=btc` | Resumen de presets Zentinel locales |
| `GET` | `/api/history` | Historial local (SQLite) |
| `GET` | `/api/history/:id` | Detalle de una entrada |
| `DELETE` | `/api/history` / `/api/history/:id` | Limpiar / borrar |
| `GET` | `/api/artifacts` | Lista fresca de artefactos en `docs/Artifacts` |
| `POST` | `/api/artifacts/scan` | Re-escaneo explícito (mismo resultado) |
| `GET` | `/api/artifacts/item?path=` | Meta + contenido (texto) o `rawUrl` |
| `GET` | `/api/artifacts/raw?path=` | Sirve el archivo (path seguro bajo Artifacts) |

### Ejemplo `POST /api/signals/run`

```json
{
  "market": "btc",
  "tier": "high",
  "bullish": true,
  "breakSetup": true,
  "ml": true,
  "neural": true,
  "ilustrate": true,
  "advanced": true,
  "noChart": true,
  "entry": "97450.5"
}
```

Tiers: `context` | `light` | `high` | `history`.

## Ejecución en MetaTrader 5 (puente local)

Envía el **Plan concreto** de una señal `ENTRAR` (Entry / SL / TP) al terminal MT5 de este Windows, **siempre con confirmación**:

- Al terminar una señal `ENTRAR` se abre el diálogo **¿Enviar esta operación?** con la vista previa validada por MT5 (`dryRun`): cuenta demo/real, lado, mercado o LIMIT, entrada, SL, TP y lotes (editables). **No enviar** la descarta.
- El botón **Enviar a MT5…** del resultado permite enviarla más tarde (último reporte del mercado visible).
- Precio del broker **en o mejor** que la entrada óptima → orden **a mercado**.
- Precio aún **no llega** a la entrada → **BUY/SELL LIMIT** en la entrada (expira a los `MT5_EXPIRY_MINUTES`; por defecto 0 = no caduca).
- SL y TP van siempre adjuntos. El lado (LONG/SHORT) se deduce de SL/TP; un plan incoherente no se envía.
- Lotaje por riesgo: `equity × MT5_RISK_PCT %` / pérdida hasta el SL (o `MT5_VOLUME` fijo).
- Bloqueos: cuenta REAL (salvo `MT5_ALLOW_REAL=1`), precio broker a más de `MT5_MAX_DEVIATION_PCT` % de la entrada, precio ya fuera de SL/TP, posición/orden abierta del mismo magic en el símbolo, misma señal enviada dos veces.

**Run operation** (historial de `/senales`, vista detallada): única vía de ejecución desde la UI. Solo la **última señal** y hasta **30 min** después de terminar (validado también en la API). Vista previa (dry-run) → *Confirmar y enviar*; color del botón según veredicto (NO OPERAR rojo, ESPERAR amarillo, resto verde). Una sola vez por señal y perfil (`data/mt5-sent.json`).

**Operación manual** (solo API, `POST /api/mt5/manual`): dirección, tipo (mercado / limit / stop), entrada, SL/TP opcionales y lotes (o riesgo % si hay SL). Ignora los chequeos de señal; token, bloqueo de cuenta REAL y Algo Trading siguen aplicando.

`run-api.ps1` y `run-both.ps1` preparan MT5 automáticamente: abren el terminal MetaTrader 5 si no está abierto, instalan la librería `MetaTrader5` si falta y lanzan el puente de Conf principal (y el de Conf secundaria si `MT5_TERMINAL_PATH_SECUNDARIA` está definido). Un puente que ya escucha no se duplica. `-NoMt5` lo omite. Solo falta activar **Algo Trading** en el terminal.

```powershell
.\run-both.ps1                            # API + web + terminal MT5 + puente(s)
.\run-api.ps1 -NoMt5                      # solo la API
# Manual:
.\run-mt5-bridge.ps1                      # Conf principal: http://127.0.0.1:8765 (MT5_BRIDGE_TOKEN)
.\run-mt5-bridge.ps1 -Perfil secundaria   # Conf secundaria: :8766 (MT5_BRIDGE_TOKEN_SECUNDARIA, MT5_TERMINAL_PATH_SECUNDARIA)
```

**Configuración** (`/configuracion`): dos perfiles, **Conf principal** y **Conf secundaria** (p.ej. otra cuenta/terminal con su propio puente en `MT5_BRIDGE_PORT=8766`), y un selector del perfil **en uso** para enviar operaciones (el diálogo de confirmación indica cuál se usará). Cada perfil tiene URL/token del puente, símbolos del broker, riesgo % o lotes fijos, distancia máx. broker↔señal, caducidad LIMIT, deslizamiento y operaciones múltiples. Se guarda en `data/mt5-settings.json` (gitignore) y aplica al siguiente envío sin reiniciar. Botón **Probar conexión** muestra cuenta demo/real, balance y Algo Trading. Las variables de entorno solo dan los valores por defecto:

| Variable | Default | Uso |
|----------|---------|-----|
| `MT5_SYMBOL_BTC` / `_US30` / `_XAUUSD` | `BTCUSD` / `US30` / `XAUUSD` | Nombre del símbolo en tu broker (p.ej. `US30.cash`, `XAUUSDm`) |
| `MT5_RISK_PCT` | `0.5` | % de equity arriesgado hasta el SL |
| `MT5_VOLUME` | — | Lotes fijos (ignora el riesgo %) |
| `MT5_MAX_DEVIATION_PCT` | `1` | Máx. distancia broker ↔ entrada de la señal |
| `MT5_EXPIRY_MINUTES` | `0` | Caducidad de la orden LIMIT (0 = no caduca) |
| `MT5_BRIDGE_URL` / `MT5_BRIDGE_TOKEN` | `http://127.0.0.1:8765` / — | Ubicación y token compartido del puente |
| `MT5_ALLOW_REAL`, `MT5_MAGIC`, `MT5_TERMINAL_PATH`, `MT5_LOGIN`/`MT5_PASSWORD`/`MT5_SERVER` | — | Solo en el puente (`bridge.py`) |

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/mt5/health?profile=` | Estado del puente del perfil (por defecto el activo), cuenta (demo/real), Algo Trading |
| `GET` / `PATCH` | `/api/mt5/settings` | Lee perfiles + activo; `PATCH { profile, settings }` guarda un perfil, `PATCH { active }` cambia el perfil en uso. El token nunca se devuelve (`hasToken`) |
| `POST` | `/api/mt5/push` | Envía `{ "historyId": 42 }`, la última señal terminada o `{ "market": "xauusd" }` (último reporte). Opcionales: `dryRun` (vista previa), `volume`, `riskPct`, `allowMultiple` |
| `GET` | `/api/volatility/vix?profile=` | VIX actual `{ points, source, sourceLabel, asOf, stale, level, multiplier, attempts }` (caché 60 s). `502 { error }` si fallan el broker y Yahoo |
| `GET` | `/api/volatility/atr?market=btc&timeframe=M5` | Movimiento típico (ATR14) del mercado con velas del broker (solo lectura) |
| `POST` | `/api/volatility/calc` | Calculadora: `{ market, mood, riskPct, balance? }` → distancias SL/TP, lotes y dinero en juego |

### Volatilidad (VIX) en `/configuracion`

Sección por perfil con tres partes (todo se guarda con **Guardar**):

- **Calcular VIX actual**: usa el símbolo VIX del broker si existe (campo opcional `vixSymbol`; vacío = el puente lo busca con `GET /symbols?query=VIX`) y, si no hay o no cotiza, Yahoo Finance `^VIX`. Muestra puntos, nivel (termómetro), fuente y hora. Cuenta Exness demo: no tiene símbolo VIX, así que sale de Yahoo. Si Node rechaza el certificado TLS (antivirus/proxy en Windows) se añade el almacén de certificados del sistema automáticamente.
- **Ajustar SL/TP según la volatilidad (VIX)** (interruptor, **desactivado por defecto**): al enviar una operación desde Run operation (señales) las distancias entrada→SL y entrada→TP de la señal se multiplican por el multiplicador del nivel y **después** se suma el margen extra en pips. Si falla la lectura del VIX la orden no se bloquea: ×1 y aviso (`volatilityNote` en el resultado y en la vista previa). Con el interruptor apagado no se consulta el VIX. Duplicar y la operación manual no se ajustan.
- **Calculadora de volatilidad**: mercado + % de riesgo + «qué tan movido está» (+ saldo opcional) → Stop Loss / Take Profit recomendados, lotes y dinero que se pierde o gana. **Usar estos valores** copia el margen extra y el riesgo % al formulario (sin guardar).

| Nivel | Puntos VIX | Multiplicador SL/TP |
|-------|------------|---------------------|
| Baja | < 15 | ×0,8 |
| Normal | 15 – 20 | ×1,0 |
| Alta | 20 – 30 (30 incluido) | ×1,3 |
| Extrema | > 30 | ×1,6 |

Umbrales y multiplicadores son editables por perfil (umbrales crecientes; multiplicadores 0,2–4). Lógica pura en `server/volatility.js`; fuente del VIX en `server/vix-source.js`. Tras actualizar hay que **reiniciar la API y el puente** (`bridge.py` añade `GET /symbols` y `GET /symbol`, solo lectura).

## Limitaciones

- **TradingView no se lee en vivo** — presets Zentinel son locales (`config/zentinel_presets.yaml`); el checklist TV sigue siendo manual.
- **Una sola corrida a la vez** — `409` si ya hay un job `running`.
- **History** = revisión P&L de la última Entry; **no** genera señal nueva.
- **Context** no acepta flags de bias/ML (el script no los usa).
- **Super High** (captura TV) no está en esta UI a propósito.
- Si falla el runner de Cursor Trading, la UI muestra el error real (no inventa un plan).
- **Docker Linux**: no ejecuta el pipeline `.ps1` Windows; usa modo `-HostApi` para señales reales.

## Estructura

```
flash-signals-angular/
  src/app/pages/historial/    # Página /senales: formulario de corrida + historial local
  src/app/shared/signal-run-form.component.*  # «Configurar corrida» + estado del job
  src/app/pages/wiki/         # Wiki de artefactos (/wiki)
  src/app/shared/             # Report viewer compartido
  src/app/services/           # Cliente HTTP → /api
  src/assets/logo.png         # Logo (versionado)
  docs/Artifacts/             # Artefactos Cursor AI (versionar útiles; ver README)
  server/index.js             # Express API (:3847)
  server/artifacts.js         # Escaneo seguro docs/Artifacts
  server/db/                  # Hive box: schema + history-store (SQLite)
  data/                       # signals-history.sqlite (gitignored)
  proxy.conf.json             # /api → :3847
  run-api.ps1                 # Arranca API (host)
  run-local-web.ps1           # Arranca Angular (:4400)
  .vscode/                    # launch.json + tasks.json (F5 / hot reload)
  run-docker.ps1              # UI(+API) vía Docker
  run-docker-arm.ps1          # Docker ARM64
  Dockerfile.web              # Build Angular + nginx
  Dockerfile.api              # Runtime Express
  docker-compose*.yml
  docker/nginx*.conf
  .cursor/rules/              # Reglas Cursor
  CLAUDE.md                   # Contexto Claude
  .run-logs/                  # Logs locales de arranque (gitignored)
  README.md
```

## Sin esta app (CLI directo)

```powershell
cd "D:\Danilo\Trading\Cursor Trading"
.\scripts\analyze\analyze-btc-high.ps1 -NoChart -Bullish -Break -ML -Neural -Ilustrate -Advanced -NoOpen
```
