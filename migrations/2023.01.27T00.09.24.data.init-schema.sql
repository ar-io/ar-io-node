CREATE TABLE IF NOT EXISTS contiguous_data  (
  hash BLOB PRIMARY KEY,
  data_size INTEGER NOT NULL,
  original_source_content_type TEXT,
  indexed_at INTEGER NOT NULL,
  cached_at INTEGER
);

CREATE TABLE IF NOT EXISTS contiguous_data_ids (
  id BLOB PRIMARY KEY,
  contiguous_data_hash BLOB,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  indexed_at INTEGER NOT NULL,
  verified_at INTEGER
);

CREATE INDEX IF NOT EXISTS contiguous_data_ids_contiguous_data_hash_idx ON contiguous_data_ids (contiguous_data_hash);

CREATE TABLE IF NOT EXISTS data_roots (
  data_root BLOB PRIMARY KEY,
  contiguous_data_hash BLOB,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  indexed_at INTEGER NOT NULL,
  verified_at INTEGER
);

CREATE INDEX IF NOT EXISTS data_roots_contiguous_data_hash_idx ON data_roots (contiguous_data_hash);
