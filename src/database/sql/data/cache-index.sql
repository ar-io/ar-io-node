-- saveContiguousDataCacheEntry
-- On first cache, cached_at and last_access are both the write time. A re-cache
-- refreshes last_access (recency) and can only raise the tier; cached_at is left
-- as the original first-cached time.
INSERT INTO contiguous_data_cache (hash, size, cached_at, last_access, tier)
VALUES (@hash, @size, @cached_at, @cached_at, @tier)
ON CONFLICT (hash) DO UPDATE SET
  size = excluded.size,
  last_access = excluded.cached_at,
  tier = MAX(contiguous_data_cache.tier, excluded.tier)

-- touchContiguousDataCacheEntry
-- On a cache hit: refresh recency and promote the tier if the request came in
-- via a preferred ArNS name (@tier = 1). MAX(tier, @tier) never demotes.
UPDATE contiguous_data_cache
SET last_access = @last_access,
    tier = MAX(tier, @tier)
WHERE hash = @hash

-- insertContiguousDataCacheEntryIfAbsent
-- Backfill/reconcile: seed a row for an on-disk blob only if one doesn't already
-- exist, so it never clobbers a live cache-write entry. last_access is seeded
-- from cached_at (which the reconciler derives from the filesystem timestamps),
-- preserving the relatime read-recency snapshot as the initial eviction order.
INSERT INTO contiguous_data_cache (hash, size, cached_at, last_access, tier)
VALUES (@hash, @size, @cached_at, @cached_at, @tier)
ON CONFLICT (hash) DO NOTHING

-- sumContiguousDataCacheBytes
SELECT COALESCE(SUM(size), 0) AS total_bytes
FROM contiguous_data_cache

-- countContiguousDataCacheEntries
SELECT COUNT(*) AS count
FROM contiguous_data_cache

-- selectContiguousDataCacheEvictionCandidates
-- Oldest-accessed-first within the lowest tier: evict the general group before
-- preferred, least-recently-used first.
SELECT hash, size
FROM contiguous_data_cache
ORDER BY tier ASC, last_access ASC
LIMIT @limit

-- deleteContiguousDataCacheEntry
DELETE FROM contiguous_data_cache
WHERE hash = @hash
