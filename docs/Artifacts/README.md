# Artefactos Cursor AI

Deja aquí los artefactos generados o exportados desde **Cursor** (análisis, notas, HTML, imágenes, PDF, etc.).

La UI **Wiki** (`/wiki`) los lista y previsualiza vía la API local (`GET /api/artifacts`).

## Cómo añadir

1. Copia o guarda el archivo en esta carpeta (o en una subcarpeta).
2. Extensiones útiles: `.md`, `.html`, `.txt`, `.png`, `.jpg`, `.pdf`.
3. En la Wiki, pulsa **Actualizar / Escanear** para refrescar la lista.

## Seguridad

Solo se sirven archivos **bajo** `docs/Artifacts`. La API bloquea path traversal (`..`) y corre en localhost.

## Ejemplo

Este `README.md` es el artefacto de ejemplo versionado. Puedes dejarlo o reemplazarlo por tus propios documentos.
