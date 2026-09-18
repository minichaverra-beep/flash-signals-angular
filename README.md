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

- **Node.js** 20+ (LTS recomendado; Node 23 suele funcionar con avisos)
- **npm**
- **Python** del mismo entorno que usas con Cursor Trading (`requirements*.txt` del stack)
- **PowerShell** (Windows)
- Variable **`CURSOR_TRADING_ROOT`** apuntando a la raíz del repo trading (default abajo)

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

```powershell
$env:CURSOR_TRADING_ROOT = "D:\Danilo\Trading\Cursor Trading"
$env:PORT = "3847"
```

## Arranque

### Recomendado — scripts PowerShell

Dos terminales desde la carpeta del proyecto:

```powershell
cd "D:\Danilo\Trading\flash-signals-angular"

# Terminal 1 — API Express → http://localhost:3847
.\run-api.ps1

# Terminal 2 — Angular → http://localhost:4200
.\run-local-web.ps1
```

Los scripts cambian al directorio del proyecto, instalan deps si faltan, y `run-api.ps1` define `CURSOR_TRADING_ROOT` si no está seteado.

| Servicio | Puerto | URL |
|----------|--------|-----|
| API | **3847** | http://localhost:3847 |
| Web (Angular + proxy `/api`) | **4200** | http://localhost:4200 |

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

## Tabs de la UI

| Tab | Qué muestra |
|-----|-------------|
| **Modo Trader** | Vista técnica: veredicto, plan, setup, scores, checklists, volumen y gráfico |
| **Modo Inversor** | Vista simplificada: decisión, plan, riesgo y scores en lenguaje claro |
| **Cómo usar** | Guía rápida (visible sin haber corrido una señal) |

## Features UI

- **Cards colapsables** (`<details>`) para veredicto, plan, setup, scores, checklists, gráfico, etc.
- **Gráfico PNG** vía `GET /api/signals/chart?market=btc|us30` (abre en pestaña nueva desde la card «Gráfico»)
- **Crédito** en el header: *Creado por: Danilo Chaverra*
- **Branding** *Flash Signals · fire & shadow* + logo (`assets/logo.png`, también favicon)
- Formulario: mercado BTC/US30, tiers Context / Light / High / History, flags (Bullish/Bearish, Break/Reverse, ML, Neural, Ilustrate, Advanced, Entry en High)
- Recarga del último reporte live sin volver a ejecutar

## Endpoints API principales

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/health` | Estado, `CURSOR_TRADING_ROOT` y job actual |
| `POST` | `/api/signals/run` | Lanza el `.ps1` correspondiente (una corrida a la vez) |
| `GET` | `/api/signals/status` | Job actual (logs / done / error) |
| `GET` | `/api/signals/latest?market=btc&tier=high` | Último `.md` parseado en `live/` |
| `GET` | `/api/signals/chart?market=btc` | PNG anotado (`btc_m5_chart_annotated.png` / US30) |
| `GET` | `/api/zentinel?market=btc` | Resumen de presets Zentinel locales |

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

## Estructura

```
flash-signals-angular/
  src/app/pages/home/   # UI (tabs Trader / Inversor / Guía)
  src/app/services/     # Cliente HTTP → /api
  src/assets/logo.png   # Logo (versionado)
  server/index.js       # Express API (:3847)
  proxy.conf.json       # /api → :3847
  run-api.ps1           # Arranca API
  run-local-web.ps1     # Arranca Angular (:4200)
  .run-logs/            # Logs locales de arranque (gitignored)
  README.md
```

## Sin esta app (CLI directo)

```powershell
cd "D:\Danilo\Trading\Cursor Trading"
.\scripts\analyze\analyze-btc-high.ps1 -NoChart -Bullish -Break -ML -Neural -Ilustrate -Advanced -NoOpen
```
