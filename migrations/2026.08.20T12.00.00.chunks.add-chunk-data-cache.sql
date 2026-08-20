-- Indexed eviction for the chunk data cache (ADR 005).
--
-- A per-dataRoot index so a disk-pressure evictor can query "oldest N in tier T"
-- instead of walking the (very large, deeply-sharded) chunk cache directory
-- tree. Raw chunk bytes stay on the filesystem under a per-dataRoot directory;
-- this table owns the eviction metadata, mirroring the contiguous_data_cache
-- pattern.
--
-- `data_root` is the base64url data root, stored as TEXT (NOT BLOB like
-- chunk_placements) because it must round-trip unchanged to the on-disk
-- directory name so the evictor can unlink that directory.
--
-- `size` and `chunk_count` accumulate across the chunk writes that land under
-- the same data_root; eviction is all-or-nothing per data_root, so they describe
-- the whole unit that would be reclaimed.
--
-- `last_write` is THE AGE-FLOOR FIELD: it is max(write time) over all chunks
-- under this data_root, NOT the first-write time. ADR 005 called this
-- `cached_at`, mirroring contiguous_data_cache where cached_at is
-- immutable-on-upsert. That is a correctness bug at data_root granularity:
-- because eviction removes every chunk of a data_root at once, a data_root first
-- seen hours ago that has just received a fresh chunk must NOT be evictable.
-- The upsert therefore advances last_write with MAX(), and the eviction query
-- floors on it.
--
-- `last_access` is max(read time). It drives LRU eviction ORDERING only and is
-- never the age floor.
--
-- `tier` orders eviction: lower tiers are evicted first. It is retained at
-- DEFAULT 0 and always written 0 for now; keeping the column and the
-- (tier, last_access) index shape identical to the proven contiguous index makes
-- ingest-origin tiering later a config change rather than a migration.
CREATE TABLE IF NOT EXISTS chunk_data_cache (
  data_root    TEXT    NOT NULL PRIMARY KEY,
  size         INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL,
  last_write   INTEGER NOT NULL,
  last_access  INTEGER,
  tier         INTEGER NOT NULL DEFAULT 0
);

-- Eviction sweep: ORDER BY tier ASC, last_access ASC. tier leads so the planner
-- evicts the general group least-recently-used first before touching any higher
-- tier.
CREATE INDEX IF NOT EXISTS chunk_data_cache_eviction_idx
  ON chunk_data_cache (tier, last_access);
