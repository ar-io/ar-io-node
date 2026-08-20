CREATE TABLE chunk_placements (
  data_root        BLOB    NOT NULL,
  relative_offset  INTEGER NOT NULL,
  data_size        INTEGER NOT NULL,
  chunk_size       INTEGER NOT NULL,
  hash             BLOB    NOT NULL,
  data_path        BLOB    NOT NULL,
  tx_path          BLOB,
  origin           INTEGER NOT NULL,
  cached_at        INTEGER NOT NULL,
  confirmed_at     INTEGER,
  PRIMARY KEY (data_root, relative_offset)
);
CREATE INDEX chunk_placements_hash_idx
  ON chunk_placements (hash);
CREATE INDEX chunk_placements_gc_idx
  ON chunk_placements (confirmed_at, cached_at);
CREATE TABLE confirmed_data_roots (
  data_root    BLOB    PRIMARY KEY,
  confirmed_at INTEGER NOT NULL
);
CREATE INDEX chunk_placements_confirmed_sibling_idx
  ON chunk_placements (data_root)
  WHERE confirmed_at IS NOT NULL;
CREATE TABLE chunk_data_cache (
  data_root    TEXT    NOT NULL PRIMARY KEY,
  size         INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL,
  last_write   INTEGER NOT NULL,
  last_access  INTEGER,
  tier         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chunk_data_cache_eviction_idx
  ON chunk_data_cache (tier, last_access);
