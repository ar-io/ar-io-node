-- Down migration: drop indexes before the table they cover.
DROP INDEX IF EXISTS chunk_data_cache_eviction_idx;
DROP TABLE IF EXISTS chunk_data_cache;
