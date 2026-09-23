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
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_signal_history_created
  ON signal_history (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_history_market
  ON signal_history (market);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
