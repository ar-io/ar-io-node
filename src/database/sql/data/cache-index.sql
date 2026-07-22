-- saveContiguousDataCacheEntry
-- Upsert one blob's eviction metadata. A re-cache refreshes cached_at (recency)
-- and can only raise the tier (once preferred, stays preferred).
INSERT INTO contiguous_data_cache (hash, size, cached_at, tier)
VALUES (@hash, @size, @cached_at, @tier)
ON CONFLICT (hash) DO UPDATE SET
  size = excluded.size,
  cached_at = excluded.cached_at,
  tier = MAX(contiguous_data_cache.tier, excluded.tier)

-- insertContiguousDataCacheEntryIfAbsent
-- Backfill/reconcile: seed a row for an on-disk blob only if one doesn't already
-- exist, so it never clobbers a live cache-write entry (which has the accurate
-- cached_at/tier). Run per row inside a batching transaction.
INSERT INTO contiguous_data_cache (hash, size, cached_at, tier)
VALUES (@hash, @size, @cached_at, @tier)
ON CONFLICT (hash) DO NOTHING

-- sumContiguousDataCacheBytes
SELECT COALESCE(SUM(size), 0) AS total_bytes
FROM contiguous_data_cache

-- countContiguousDataCacheEntries
SELECT COUNT(*) AS count
FROM contiguous_data_cache

-- selectContiguousDataCacheEvictionCandidates
-- Oldest-first within the lowest tier: evict the general group before preferred.
SELECT hash, size
FROM contiguous_data_cache
ORDER BY tier ASC, cached_at ASC
LIMIT @limit

-- deleteContiguousDataCacheEntry
DELETE FROM contiguous_data_cache
WHERE hash = @hash
