-- Ajustes de la cuenta de trading (balance y % de riesgo para el lote recomendado).
-- Archivo: data/account-settings.sqlite (gitignored). Una sola fila (id = 1).

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS account_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  risk_pct REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_settings_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
