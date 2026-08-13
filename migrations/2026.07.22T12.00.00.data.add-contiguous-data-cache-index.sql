-- Cleanup index for the contiguous data cache (PE-9131).
--
-- A dedicated per-blob index so a disk-pressure evictor can query "oldest N in
-- tier T" instead of walking the (very large, deeply-sharded, HDD-backed) cache
-- directory tree. Raw blob bytes stay on the filesystem (hash-keyed); this table
-- owns the eviction metadata, mirroring the chunk_placements pattern.
--
-- `hash` is the base64url content hash (the FsDataStore filename), stored as
-- TEXT so it can be handed straight back to the store for deletion. `tier`
-- orders eviction: lower tiers are evicted first (0 = general, 1 = preferred).
CREATE TABLE IF NOT EXISTS contiguous_data_cache (
  hash       TEXT    NOT NULL PRIMARY KEY,
  size       INTEGER NOT NULL,
  cached_at  INTEGER NOT NULL,
  tier       INTEGER NOT NULL
);

-- Eviction sweep: ORDER BY tier ASC, cached_at ASC. tier leads so the planner
-- evicts the general group oldest-first before touching preferred.
CREATE INDEX IF NOT EXISTS contiguous_data_cache_eviction_idx
  ON contiguous_data_cache (tier, cached_at);
