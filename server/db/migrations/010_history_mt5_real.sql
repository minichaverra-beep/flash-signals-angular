-- Migración 010: ejecución real en MT5 de la señal + origen del $/PnL.
-- El plan (summary_json.planDetails) no se toca: estas columnas guardan lo ejecutado.
-- Aplicada en boot por history-store.js (applyHistoryMigrations, solo si faltan).

ALTER TABLE signal_history ADD COLUMN entry_price_real REAL;   -- precio de entrada (deal IN)
ALTER TABLE signal_history ADD COLUMN exit_price_real REAL;    -- salida: media ponderada por volumen de los cierres
ALTER TABLE signal_history ADD COLUMN sl_price_real REAL;      -- SL con que se abrió la posición
ALTER TABLE signal_history ADD COLUMN opened_at_real TEXT;     -- ISO UTC del deal IN
ALTER TABLE signal_history ADD COLUMN closed_at_real TEXT;     -- ISO UTC del último deal de cierre
ALTER TABLE signal_history ADD COLUMN mt5_ticket INTEGER;      -- posición MT5
ALTER TABLE signal_history ADD COLUMN pnl_source TEXT;         -- 'mt5' | NULL (manual)
