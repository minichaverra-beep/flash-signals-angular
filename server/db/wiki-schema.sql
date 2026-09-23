-- Wiki local: metadatos de artefactos y categorías (SQLite embebido).
-- Archivo: data/wiki-meta.sqlite (gitignored). Sin DB externa.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS wiki_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_categories_sort
  ON wiki_categories (sort_order ASC, id ASC);

CREATE TABLE IF NOT EXISTS artifact_meta (
  path TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category_id INTEGER REFERENCES wiki_categories(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_meta_category
  ON artifact_meta (category_id);

CREATE TABLE IF NOT EXISTS wiki_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
