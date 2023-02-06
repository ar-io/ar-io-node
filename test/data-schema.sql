CREATE TABLE contiguous_data  (
  hash BLOB PRIMARY KEY,
  -- TODO add size
  original_source_content_type TEXT
  --created_at INTEGER NOT NULL
);
CREATE TABLE contiguous_data_ids (
  id BLOB PRIMARY KEY,
  contiguous_data_hash BLOB
  content_type TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE
  --created_at INTEGER NOT NULL,
  --verified_at INTEGER
);
CREATE INDEX contiguous_data_ids_contiguous_data_hash_idx ON contiguous_data_ids (contiguous_data_hash);
CREATE TABLE data_roots (
  data_root BLOB PRIMARY KEY,
  contiguous_data_hash BLOB
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX data_roots_contiguous_data_hash_idx ON data_roots (contiguous_data_hash);
