-- Migración 007: motivo de entrada/salida (anotación del trader).
-- Aplicada en boot por history-store.js (ALTER if missing).

ALTER TABLE signal_history ADD COLUMN motivo_entrada_salida TEXT;
