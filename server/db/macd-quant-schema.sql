-- Historial de análisis MACD-quant H4 (SQLite embebido).
-- Archivo: data/macd-quant-history.sqlite (gitignored).
-- PNG durables en data/macd-quant-charts/ (no depender solo de live/).

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS macd_quant_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  market TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT 'H4',
  days REAL,
  status TEXT NOT NULL,
  -- Soft-filter: flags/resumen (nunca inventa WR/PF)
  soft_filter_json TEXT,
  -- Parámetros MACD opcionales (baseline 12/26/9)
  params_json TEXT,
  -- Copia durable del PNG (nombre bajo data/macd-quant-charts/)
  png_name TEXT,
  -- Ruta original en live/ (solo referencia; puede sobrescribirse)
  source_png_path TEXT,
  command TEXT,
  exit_code INTEGER,
  error TEXT,
  logs_tail TEXT
);

CREATE INDEX IF NOT EXISTS idx_macd_quant_created
  ON macd_quant_history (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_macd_quant_market
  ON macd_quant_history (market);

CREATE TABLE IF NOT EXISTS macd_quant_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
