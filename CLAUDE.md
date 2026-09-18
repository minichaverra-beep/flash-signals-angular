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
6. Branding: *Flash Signals · fire & shadow*, crédito **Danilo Chaverra**, `src/assets/logo.png`.

## Stack técnico

- Angular 19 (`src/app/pages/home`, `src/app/services/signals-api.service.ts`)
- Express 5 CommonJS en `server/` (deps en `server/package.json`)
- Scripts host: `run-api.ps1`, `run-local-web.ps1`
- Docker: `Dockerfile.web`, `Dockerfile.api`, `docker-compose.yml`, `run-docker.ps1`, `run-docker-arm.ps1`

## UI

- Tabs: **Modo Trader** (técnico) · **Modo Inversor** (simple) · **Cómo usar**
- Cards colapsables; formulario de mercado/tier/flags

## Endpoints clave

- `GET /api/health` — incluye `signalsRunnable` / `platform`
- `POST /api/signals/run` — una job a la vez
- `GET /api/signals/status`, `latest`, `chart`
- `GET /api/zentinel`

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

# Sin Node: Docker UI (+ API mock/limitada) o híbrido
.\run-docker.ps1
.\run-docker.ps1 -HostApi   # UI Docker + API Windows
.\run-docker-arm.ps1        # ARM64
```

## Al cambiar código

- Preferir cambios mínimos y alineados con Express + Angular 19 existentes.
- No añadir Super High / lectura live de TradingView salvo pedido explícito.
- Si tocas Docker, puertos o límites de señales, actualiza `README.md`.
- Idioma de UI/mensajes: español (usuario Danilo).
