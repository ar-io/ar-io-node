-- saveChunkPlacement
INSERT INTO chunk_placements (
  data_root, relative_offset, data_size, chunk_size, hash,
  data_path, tx_path, origin, cached_at, confirmed_at
) VALUES (
  @data_root, @relative_offset, @data_size, @chunk_size, @hash,
  @data_path, @tx_path, @origin, @cached_at,
  -- Sticky confirmation: inherit confirmed_at when the data_root is already
  -- confirmed. Confirmation is triggered ONCE per data_root by the TX_INDEXED
  -- event (a one-shot UPDATE that only touches placements present at that
  -- instant). A large multi-GB bundle streams its chunks in over a window far
  -- longer than that single event, so most arrive AFTER it and — without this —
  -- stay unconfirmed and get TTL-evicted, leaving a gappy, unservable set (e.g.
  -- relative_offset 0 missing -> retrieval streams from 0, misses, and fails).
  -- Prefer the `confirmed_data_roots` marker (set at confirm time, persists
  -- independently of which chunks were present then); fall back to a confirmed
  -- sibling for robustness. An explicit @confirmed_at (caller already knows)
  -- always wins.
  COALESCE(
    @confirmed_at,
    (
      SELECT confirmed_at
      FROM confirmed_data_roots
      WHERE data_root = @data_root
    ),
    (
      SELECT sibling.confirmed_at
      FROM chunk_placements AS sibling
      WHERE sibling.data_root = @data_root
        AND sibling.confirmed_at IS NOT NULL
      LIMIT 1
    )
  )
)
ON CONFLICT (data_root, relative_offset) DO UPDATE SET
  data_size = excluded.data_size,
  chunk_size = excluded.chunk_size,
  hash = excluded.hash,
  data_path = excluded.data_path,
  tx_path = COALESCE(excluded.tx_path, chunk_placements.tx_path),
  -- Never reset an existing confirmation back to NULL on re-ingest; and pick up a
  -- sibling-inherited confirmation carried in via excluded.confirmed_at.
  confirmed_at = COALESCE(chunk_placements.confirmed_at, excluded.confirmed_at)

-- confirmChunkPlacements
UPDATE chunk_placements
SET confirmed_at = @confirmed_at
WHERE data_root = @data_root
  AND confirmed_at IS NULL
RETURNING cached_at

-- markDataRootConfirmed
-- Record the data_root as confirmed so chunks ingested AFTER the one-shot
-- confirmation still confirm (via saveChunkPlacement's inheritance) and are
-- retained (via the GC's exclusion).
--
-- Recorded UNCONDITIONALLY (no EXISTS-in-chunk_placements gate). The confirming
-- TX_INDEXED event frequently fires BEFORE any of the bundle's chunks are
-- ingested: with the bundler's TX-confirmation broadcast gate, chunk seeding
-- waits for network confirmation, and the gateway imports that same block first
-- — so the confirm event routinely wins the race and finds zero chunks present.
-- An EXISTS gate would then skip the marker and every later-seeded chunk would
-- stay pending and TTL-evict (proven end-to-end: confirm fired ~2s before the
-- first chunk, all 1025 chunks evicted, offset 0 lost). Marking unconditionally
-- bridges the race in both orderings. The marker table is kept bounded by an
-- age-based prune in the GC sweep (see pruneConfirmedDataRoots); it only needs to
-- outlive the confirm->seed gap (seconds), not the chunk TTL. First confirmation
-- wins (DO NOTHING on conflict). This event only fires for txs with a non-empty
-- data_root (data txs), and only while chunk ingest is enabled.
INSERT INTO confirmed_data_roots (data_root, confirmed_at)
VALUES (@data_root, @confirmed_at)
ON CONFLICT (data_root) DO NOTHING

-- pruneConfirmedDataRoots
-- Bound the marker table: a marker only needs to bridge the gap between a tx
-- confirming and its chunks being seeded (seconds to a couple of minutes). Once a
-- chunk is ingested it carries its own confirmed_at, so the marker is redundant
-- after that. Delete markers older than the caller's cutoff.
DELETE FROM confirmed_data_roots
WHERE confirmed_at < @cutoff

-- countConfirmedDataRoots
SELECT COUNT(*) AS count FROM confirmed_data_roots

-- unconfirmChunkPlacements
UPDATE chunk_placements
SET confirmed_at = NULL
WHERE data_root = @data_root

-- selectExpiredUnconfirmedPlacements
-- Never TTL-evict a chunk whose data_root is confirmed, even if this individual
-- row is still marked pending: once a bundle is confirmed we keep the WHOLE set
-- so it stays servable/unbundlable. This guards against a straggler chunk that
-- was ingested but hasn't picked up confirmation for any reason.
SELECT data_root, relative_offset, chunk_size
FROM chunk_placements
WHERE confirmed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM confirmed_data_roots c
    WHERE c.data_root = chunk_placements.data_root
  )
  AND (
    (origin = @origin_ingest AND cached_at < @open_cutoff)
    OR (origin = @origin_ingest_allowlisted AND cached_at < @allow_cutoff)
  )
ORDER BY cached_at ASC
LIMIT @limit

-- selectOldestPendingPlacements
SELECT data_root, relative_offset, chunk_size
FROM chunk_placements
WHERE confirmed_at IS NULL
ORDER BY cached_at ASC
LIMIT @limit

-- deleteChunkPlacement
-- Guarded by `confirmed_at IS NULL` so a placement confirmed between the GC
-- sweep's SELECT and this DELETE is NOT evicted (TOCTOU). The caller relies on
-- the returned change count to decide whether to also unlink the FS bytes.
DELETE FROM chunk_placements
WHERE data_root = @data_root
  AND relative_offset = @relative_offset
  AND confirmed_at IS NULL

-- getChunkPlacement
SELECT data_root, relative_offset, data_size, chunk_size, hash,
  data_path, tx_path, origin, cached_at, confirmed_at
FROM chunk_placements
WHERE data_root = @data_root
  AND relative_offset = @relative_offset

-- sumPendingChunkBytes
SELECT COALESCE(SUM(chunk_size), 0) AS pending_bytes
FROM chunk_placements
WHERE confirmed_at IS NULL
