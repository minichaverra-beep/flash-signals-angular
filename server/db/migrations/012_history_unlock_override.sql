-- Migración 012: desbloqueo puntual de filas de días anteriores.
-- Una operación de un día local anterior (HISTORY_TZ / zona del sistema, sobre created_at) queda en
-- solo lectura salvo unlock_override = 1. Volver a bloquear la fila limpia el override.
-- Aplicada en boot por history-store.js (applyHistoryMigrations, solo si faltan).

ALTER TABLE signal_history ADD COLUMN unlock_override INTEGER NOT NULL DEFAULT 0;  -- 1 = desbloqueada a mano
ALTER TABLE signal_history ADD COLUMN unlock_override_at TEXT;                     -- ISO UTC del desbloqueo
