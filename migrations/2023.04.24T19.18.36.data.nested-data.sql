CREATE TABLE IF NOT EXISTS contiguous_data_parents (
  hash BLOB NOT NULL,
  parent_hash BLOB NOT NULL,
  data_offset INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (hash, parent_hash)
);

CREATE TABLE IF NOT EXISTS contiguous_data_id_parents (
  id BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  data_offset INTEGER NOT NULL,
  data_size INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (id, parent_id)
);
