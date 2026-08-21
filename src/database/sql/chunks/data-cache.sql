-- saveChunkDataCacheEntry
-- Chunk-write hook: create or extend the eviction entry for a data_root.
-- size and chunk_count ACCUMULATE across the chunks written under the same
-- data_root, because eviction is all-or-nothing per data_root.
--
-- last_write is the AGE FLOOR and advances to the newest write
-- (MAX(last_write, excluded.last_write)) rather than staying pinned to the
-- first write. A data_root first seen hours ago that just received a fresh chunk
-- must not become evictable, since evicting it would take the fresh chunk with
-- it.
--
-- last_access is bumped to the write time too (a write is the most recent touch)
-- but only ever forward; it orders LRU eviction and is never the floor.
-- MAX(tier, ...) never demotes.
--
-- KNOWN DRIFT: this counts writes, not distinct chunks. Re-writing a chunk that
-- is already cached (chiefly FsChunkDataStore's zero-length self-heal path,
-- measured at roughly 2% of writes on gw2) increments chunk_count and adds its
-- bytes again, so both columns can overstate. Deliberately not corrected here:
-- the only fix without an extra stat() on the chunk write hot path would be to
-- check existence first, and the consequences are bounded and self-limiting --
-- statfs, not this sum, decides when to stop evicting, so an inflated size only
-- makes a batch reclaim less than its byte target and the next batch picks up
-- the slack; and the row is deleted on eviction, which resets the drift. It
-- does mean chunk_cache_index_bytes / _evicted_bytes_total are upper bounds,
-- not exact figures -- trust df for reclaimed space, as the contiguous index
-- documentation already advises.
INSERT INTO chunk_data_cache (
  data_root, size, chunk_count, last_write, last_access, tier
) VALUES (
  @data_root, @size, 1, @last_write, @last_write, @tier
)
ON CONFLICT (data_root) DO UPDATE SET
  size = size + excluded.size,
  chunk_count = chunk_count + 1,
  last_write = MAX(last_write, excluded.last_write),
  last_access = MAX(COALESCE(last_access, 0), excluded.last_write),
  tier = MAX(tier, excluded.tier)

-- touchChunkDataCacheEntry
-- Chunk-read hook: refresh recency (LRU ordering) and promote the tier if the
-- read arrived through a preferred path. MAX(tier, @tier) never demotes.
--
-- MUST NOT touch last_write: a read is not a write, so it must not push the
-- data_root's age floor forward and make it un-evictable forever under load.
UPDATE chunk_data_cache
SET last_access = @last_access,
    tier = MAX(tier, @tier)
WHERE data_root = @data_root

-- insertChunkDataCacheEntryIfAbsent
-- Backfill/reconcile: seed a row for an on-disk data_root directory only if one
-- doesn't already exist, so it never clobbers a live chunk-write entry. size,
-- chunk_count, last_write, and last_access all come from the caller's
-- filesystem scan.
INSERT INTO chunk_data_cache (
  data_root, size, chunk_count, last_write, last_access, tier
) VALUES (
  @data_root, @size, @chunk_count, @last_write, @last_access, @tier
)
ON CONFLICT (data_root) DO NOTHING

-- selectChunkDataCacheEvictionCandidates
-- CORRECTNESS-CRITICAL. Two independent guards, and the NOT EXISTS is the
-- primary one.
--
-- A data root with an UNCONFIRMED placement is never evictable, full stop.
-- That is the actual invariant: a chunk POSTed to this gateway must survive
-- until its data root confirms on chain. The age floor only approximates it
-- with a clock, and a clock derived from configuration cannot describe bytes
-- already on disk -- disabling the ingest cache would otherwise shorten the
-- floor out from under chunks that are still in flight. Placements are the
-- record of what is actually pending, so ask them.
--
-- This also gets the read-through path right for free: chunks cached from the
-- network have no placement row at all, so they stay freely evictable, which
-- is correct -- they can simply be refetched.
--
-- The age floor remains as a backstop for anything the placement index does
-- not know about. Only a data_root whose newest chunk write is at or before
-- @max_last_write may be evicted.
-- Without it, a data_root still actively receiving chunks (or one whose chunks
-- were all just written but not yet read) can be selected and unlinked out from
-- under an in-flight ingest, leaving a gappy, unservable chunk set.
--
-- Ordering within the eligible set is oldest-accessed-first inside the lowest
-- tier, matching chunk_data_cache_eviction_idx (tier, last_access).
SELECT c.data_root, c.size, c.chunk_count, c.last_write
FROM chunk_data_cache c
WHERE c.last_write <= @max_last_write
  AND NOT EXISTS (
    SELECT 1
    FROM chunk_placements p
    WHERE p.data_root = c.data_root
      AND p.confirmed_at IS NULL
  )
ORDER BY c.tier ASC, c.last_access ASC
LIMIT @limit

-- deleteChunkDataCacheEntry
-- CORRECTNESS-CRITICAL, and the reason this is not a bare DELETE by key.
--
-- Re-applies the AGE FLOOR at delete time, exactly as deleteChunkPlacement
-- re-checks `confirmed_at IS NULL`. The evictor selected this data_root when
-- its newest write was old enough to evict, but a chunk can land in the gap
-- between that SELECT and this DELETE: the write hook then advances
-- last_write, and because eviction unlinks the WHOLE data_root directory, an
-- unguarded delete would take the just-written chunk with it -- silently, with
-- the caller believing the chunk was cached.
--
-- Deleting 0 rows is the safe outcome: the caller unlinks only the data roots
-- this actually removed, so a data root that was written to in the gap keeps
-- both its row and its bytes and is simply reconsidered next sweep.
DELETE FROM chunk_data_cache
WHERE data_root = @data_root
  AND last_write <= @max_last_write

-- sumChunkDataCacheBytes
SELECT COALESCE(SUM(size), 0) AS total_bytes
FROM chunk_data_cache

-- countChunkDataCacheEntries
SELECT COUNT(*) AS count
FROM chunk_data_cache
