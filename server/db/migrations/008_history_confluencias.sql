-- Migración 008: catálogo de confluencias del historial + asignación multi-select.
-- Seed durable (INSERT OR IGNORE): Continuación, Reversion, Macro tendencia, …
-- Aplicada en boot por history-store.js (applyHistoryMigrations).

CREATE TABLE IF NOT EXISTS history_confluencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_confluencias_sort
  ON history_confluencias (sort_order ASC, id ASC);

CREATE TABLE IF NOT EXISTS signal_history_confluencias (
  history_id INTEGER NOT NULL REFERENCES signal_history(id) ON DELETE CASCADE,
  confluencia_id INTEGER NOT NULL REFERENCES history_confluencias(id) ON DELETE CASCADE,
  PRIMARY KEY (history_id, confluencia_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_history_confluencias_cf
  ON signal_history_confluencias (confluencia_id);
