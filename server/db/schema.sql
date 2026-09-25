-- Hive box / caja local: historial de señales (SQLite embebido).
-- No es Apache Hive ni Postgres/MySQL — archivo local data/signals-history.sqlite

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS signal_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  market TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  flags_json TEXT,
  entry TEXT,
  verdict TEXT,
  score_combined REAL,
  summary_json TEXT,
  report_path TEXT,
  chart_path TEXT,
  preview TEXT,
  command TEXT,
  exit_code INTEGER,
  error TEXT,
  -- Anotaciones del trader (editables desde /historial)
  comment TEXT,
  -- NULL | ganada | perdida | no_tomada (métricas solo con ganada/perdida)
  resultado TEXT,
  -- PnL real en USD (nullable; el trader lo rellena a mano)
  pnl_usd REAL,
  -- Captura del resultado (archivo en data/history-attachments/)
  result_image_name TEXT,
  result_image_mime TEXT
);

CREATE INDEX IF NOT EXISTS idx_signal_history_created
  ON signal_history (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_history_market
  ON signal_history (market);

-- Catálogo de etiquetas (premium/descuento, etc.) — editable desde /historial
CREATE TABLE IF NOT EXISTS history_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_tags_sort
  ON history_tags (sort_order ASC, id ASC);

-- Asignación multi-tag por fila del historial
CREATE TABLE IF NOT EXISTS signal_history_tags (
  history_id INTEGER NOT NULL REFERENCES signal_history(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES history_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (history_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_history_tags_tag
  ON signal_history_tags (tag_id);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
