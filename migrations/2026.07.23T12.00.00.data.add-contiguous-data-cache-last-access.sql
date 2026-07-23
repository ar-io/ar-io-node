-- Add last_access to the contiguous data cache index for LRU eviction (PE-9131).
--
-- cached_at stays as the immutable "first cached" timestamp (informational, and
-- leaves room for a future absolute-age policy). last_access is what eviction
-- orders by: seeded from cached_at for existing rows, refreshed on cache hits
-- when CONTIGUOUS_DATA_CACHE_INDEX_UPDATE_ON_READ is enabled (LRU); left frozen
-- otherwise (FIFO).
ALTER TABLE contiguous_data_cache ADD COLUMN last_access INTEGER;

UPDATE contiguous_data_cache SET last_access = cached_at;

-- Swap the eviction index from (tier, cached_at) to (tier, last_access).
DROP INDEX IF EXISTS contiguous_data_cache_eviction_idx;
CREATE INDEX IF NOT EXISTS contiguous_data_cache_eviction_idx
  ON contiguous_data_cache (tier, last_access);
