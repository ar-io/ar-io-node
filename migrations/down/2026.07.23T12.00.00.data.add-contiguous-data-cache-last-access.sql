DROP INDEX IF EXISTS contiguous_data_cache_eviction_idx;
CREATE INDEX IF NOT EXISTS contiguous_data_cache_eviction_idx
  ON contiguous_data_cache (tier, cached_at);
ALTER TABLE contiguous_data_cache DROP COLUMN last_access;
