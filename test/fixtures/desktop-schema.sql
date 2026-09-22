CREATE TABLE IF NOT EXISTS working_copies (
  id TEXT PRIMARY KEY,
  crux_id TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'task',
  phase TEXT NOT NULL DEFAULT 'preparing',
  meta TEXT NOT NULL DEFAULT '{}',
  project_folder TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_working_copies_crux ON working_copies(crux_id);
CREATE TABLE IF NOT EXISTS task_merges (
  id TEXT PRIMARY KEY,
  crux_id TEXT NOT NULL,
  copy_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  data TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_merge_applying ON task_merges(crux_id) WHERE phase = 'applying';

CREATE TABLE IF NOT EXISTS cruxes (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  title TEXT DEFAULT '',
  description TEXT DEFAULT '',
  data TEXT DEFAULT '',
  type TEXT DEFAULT 'crux',
  kind TEXT,
  status TEXT DEFAULT 'living',
  visibility TEXT DEFAULT 'private',
  discoverable INTEGER DEFAULT 0,
  author_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  meta TEXT DEFAULT '{}',
  remote_id TEXT,
  synced_at TEXT,
  deleted TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cruxes_slug ON cruxes(slug);
CREATE INDEX IF NOT EXISTS idx_cruxes_author ON cruxes(author_id);
CREATE INDEX IF NOT EXISTS idx_cruxes_updated ON cruxes(updated);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  type TEXT DEFAULT 'artifact',
  kind TEXT DEFAULT 'file',
  meta TEXT DEFAULT '{}',
  resource_id TEXT NOT NULL,
  resource_type TEXT DEFAULT 'crux',
  author_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  encoding TEXT DEFAULT 'utf-8',
  mime_type TEXT,
  filename TEXT,
  size INTEGER DEFAULT 0,
  fingerprint TEXT,
  path TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_resource_path ON artifacts(resource_id, path) WHERE path IS NOT NULL AND path != '';
CREATE INDEX IF NOT EXISTS idx_artifacts_resource ON artifacts(resource_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(type);
CREATE INDEX IF NOT EXISTS idx_artifacts_fingerprint ON artifacts(fingerprint);

CREATE TABLE IF NOT EXISTS dimensions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT,
  weight REAL,
  author_id TEXT,
  home_id TEXT NOT NULL,
  note TEXT,
  meta TEXT DEFAULT '{}',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dimensions_source ON dimensions(source_id);
CREATE INDEX IF NOT EXISTS idx_dimensions_target ON dimensions(target_id);
CREATE INDEX IF NOT EXISTS idx_dimensions_source_type ON dimensions(source_id, type);

CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  display_name TEXT,
  bio TEXT,
  account_id TEXT,
  home_id TEXT,
  meta TEXT DEFAULT '{}',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store (
  id TEXT PRIMARY KEY,
  crux_id TEXT NOT NULL,
  visitor_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'protected',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_public
  ON store (crux_id, key)
  WHERE visitor_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_store_protected
  ON store (crux_id, visitor_id, key)
  WHERE visitor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_crux ON store(crux_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
-- Version managed by worker.ts migrate() — do not insert here
