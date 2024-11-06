CREATE TABLE contiguous_data  (
  hash BLOB PRIMARY KEY,
  data_size INTEGER NOT NULL,
  original_source_content_type TEXT,
  indexed_at INTEGER NOT NULL,
  cached_at INTEGER
);
CREATE TABLE contiguous_data_ids (
  id BLOB PRIMARY KEY,
  contiguous_data_hash BLOB,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  indexed_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX contiguous_data_ids_contiguous_data_hash_idx ON contiguous_data_ids (contiguous_data_hash);
CREATE TABLE data_roots (
  data_root BLOB PRIMARY KEY,
  contiguous_data_hash BLOB,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  indexed_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE INDEX data_roots_contiguous_data_hash_idx ON data_roots (contiguous_data_hash);
CREATE TABLE contiguous_data_parents (
  hash BLOB NOT NULL,
  parent_hash BLOB NOT NULL,
  data_offset INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (hash, parent_hash)
);
CREATE TABLE contiguous_data_id_parents (
  id BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  data_offset INTEGER NOT NULL,
  data_size INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (id, parent_id)
);
CREATE INDEX contiguous_data_ids_verified ON contiguous_data_ids (id) WHERE verified = FALSE;
