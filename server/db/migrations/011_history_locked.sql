-- Migración 011: candado opcional por fila del historial (solo lectura mientras está bloqueada).
-- El servidor rechaza con 423 cualquier cambio sobre una fila bloqueada; desbloquear siempre se permite.
-- Aplicada en boot por history-store.js (applyHistoryMigrations, solo si faltan).

ALTER TABLE signal_history ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;  -- 1 = bloqueada
ALTER TABLE signal_history ADD COLUMN locked_at TEXT;                     -- ISO UTC del último bloqueo
