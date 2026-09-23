# Flash Signals Angular

UI local (Angular 19 + API Express) para orquestar señales **BTC / US30** del stack real **Cursor Trading**.

- **No usa Cursor AI** ni inventa señales: solo invoca los `.ps1` del repo trading y muestra el resultado (o el error real).
- Branding *fire & shadow*, crédito **Danilo Chaverra**, logo en `src/assets/logo.png`.

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

## Contexto para agentes (Cursor / Claude)

| Recurso | Ubicación |
|---------|-----------|
| Reglas Cursor | [`.cursor/rules/flash-signals.mdc`](.cursor/rules/flash-signals.mdc) |
| Contexto Claude | [`CLAUDE.md`](CLAUDE.md) |

Resumen para agentes:

- Arquitectura UI **Trader / Inversor / Cómo usar**; no inventar señales.
- Gráficos PNG solo vía API; API localhost; branding Danilo / fire & shadow.
- No commit de secretos; stack Express + Angular 19.
- Docker = UI sin Node; pipeline PowerShell→Python suele necesitar `run-api.ps1` en Windows.

## Tabs de la UI

| Tab / ruta | Qué muestra |
|------------|-------------|
| **Modo Trader** | Vista técnica: veredicto, plan, setup, scores, checklists, gráfico |
| **Modo Inversor** | Vista simplificada: decisión, plan, riesgo y scores en lenguaje claro |
| **Cómo usar** | Guía rápida (visible sin haber corrido una señal) |
| **Historial** (`/historial`) | Lista de corridas guardadas en la **caja local** SQLite |

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

## Features UI

- **Cards colapsables** (`<details>`) para veredicto, plan, setup, scores, checklists, gráfico, etc. (compartidas vía `app-signal-report-viewer`)
- **Gráfico PNG** vía `GET /api/signals/chart?market=btc|us30` (abre en pestaña nueva desde la card «Gráfico»)
- **Crédito** en el header: *Creado por: Danilo Chaverra*
- **Branding** *Flash Signals · fire & shadow* + logo (`assets/logo.png`, también favicon)
- Formulario: mercado BTC/US30, tiers Context / Light / High / History, flags (Bullish/Bearish, Break/Reverse, ML, Neural, Ilustrate, Advanced, Entry en High)
- Recarga del último reporte live sin volver a ejecutar
- **Historial**: filtro BTC/US30, fechas relativas+absolutas, badges de veredicto, drawer de detalle con Modo Trader/Inversor

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
  src/app/pages/home/         # UI señales (tabs Trader / Inversor / Guía)
  src/app/pages/historial/    # Historial local (/historial)
  src/app/shared/             # Report viewer compartido
  src/app/services/           # Cliente HTTP → /api
  src/assets/logo.png         # Logo (versionado)
  server/index.js             # Express API (:3847)
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
