-- Migration 005: resultado admite 'no_tomada' (señal no tomada)
-- Columna ya es TEXT (002); no hay ALTER.
-- Valores: NULL | 'ganada' | 'perdida' | 'no_tomada'
-- Aliases de entrada: no-tomada, no tomada, skipped, skip → no_tomada
-- Métricas: solo ganada/perdida cuentan como cerradas; no_tomada = como vacío.

INSERT OR IGNORE INTO schema_migrations (id, applied_at)
VALUES ('005_history_resultado_no_tomada', datetime('now'));
