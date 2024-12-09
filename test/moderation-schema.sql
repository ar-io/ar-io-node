CREATE TABLE block_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE blocked_ids  (
  id BLOB PRIMARY KEY,
  block_source_id INTEGER,
  notes TEXT,
  blocked_at INTEGER
);
CREATE INDEX blocked_ids_source_id_idx
  ON blocked_ids (block_source_id);
CREATE TABLE blocked_hashes (
  hash BLOB PRIMARY KEY,
  block_source_id INTEGER,
  notes TEXT,
  blocked_at INTEGER
);
CREATE INDEX blocked_hashes_source_id_idx
  ON blocked_hashes (block_source_id);
CREATE UNIQUE INDEX block_sources_name_idx ON block_sources (name);
CREATE TABLE blocked_names (
  name TEXT PRIMARY KEY,
  block_source_id INTEGER,
  notes TEXT,
  blocked_at INTEGER
);
CREATE INDEX blocked_names_source_id_idx ON blocked_names (block_source_id);
