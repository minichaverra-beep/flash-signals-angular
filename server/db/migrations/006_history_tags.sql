-- Migración 006: catálogo de etiquetas del historial + asignación por fila.
-- Seed durable (INSERT OR IGNORE): En descuento, Pre-equilibrio, Premium,
-- Macro-Pre-equilibrio, Test, Dirección.
-- Aplicada en boot por history-store.js (applyHistoryMigrations).

CREATE TABLE IF NOT EXISTS history_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_tags_sort
  ON history_tags (sort_order ASC, id ASC);

CREATE TABLE IF NOT EXISTS signal_history_tags (
  history_id INTEGER NOT NULL REFERENCES signal_history(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES history_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (history_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_history_tags_tag
  ON signal_history_tags (tag_id);
