# Calidad y SonarCloud — Flash Signals Angular

## Escaneo local (sin token)

```powershell
cd "D:\Danilo\Trading\flash-signals-angular"
npm config set registry https://registry.npmjs.org
npx tsc -p tsconfig.app.json --noEmit
# API: node --check server/index.js
```

## SonarCloud (CI)

1. En [SonarCloud](https://sonarcloud.io): importa `minichaverra-beep/flash-signals-angular`.
2. Verifica que coincidan con `sonar-project.properties`:
   - Organization: `minichaverra-beep`
   - Project key: `minichaverra-beep_flash-signals-angular`
3. Genera un token (My Account → Security).
4. En GitHub → **Settings → Secrets and variables → Actions** crea `SONAR_TOKEN`.
5. Lanza el workflow **SonarCloud** (push a `main` o *Run workflow*).

**Sin `SONAR_TOKEN` el job falla a propósito** (igual que flash-trading-signals).

## Análisis local hacia SonarCloud

```powershell
$env:SONAR_TOKEN = "<token>"
# Requiere sonar-scanner CLI + Java 17+
sonar-scanner.bat `
  -Dsonar.host.url=https://sonarcloud.io `
  -Dsonar.token=$env:SONAR_TOKEN
```

Nunca commits el token.
