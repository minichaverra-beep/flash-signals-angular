-- Migración 009: barras de cambio de cálculo en el historial.
-- Señales con created_at >= marker.created_at usan el cálculo nuevo (arriba de la barra).

CREATE TABLE IF NOT EXISTS calc_change_markers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  comment TEXT,
  market TEXT
);

CREATE INDEX IF NOT EXISTS idx_calc_change_markers_created
  ON calc_change_markers (created_at DESC);
