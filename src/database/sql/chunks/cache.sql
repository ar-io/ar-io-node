-- saveChunkPlacement
INSERT INTO chunk_placements (
  data_root, relative_offset, data_size, chunk_size, hash,
  data_path, tx_path, origin, cached_at, confirmed_at
) VALUES (
  @data_root, @relative_offset, @data_size, @chunk_size, @hash,
  @data_path, @tx_path, @origin, @cached_at, @confirmed_at
)
ON CONFLICT (data_root, relative_offset) DO UPDATE SET
  data_size = excluded.data_size,
  chunk_size = excluded.chunk_size,
  hash = excluded.hash,
  data_path = excluded.data_path,
  tx_path = COALESCE(excluded.tx_path, chunk_placements.tx_path),
  -- Never reset an existing confirmation back to NULL on re-ingest.
  confirmed_at = COALESCE(chunk_placements.confirmed_at, excluded.confirmed_at)

-- confirmChunkPlacements
UPDATE chunk_placements
SET confirmed_at = @confirmed_at
WHERE data_root = @data_root
  AND confirmed_at IS NULL
RETURNING cached_at

-- unconfirmChunkPlacements
UPDATE chunk_placements
SET confirmed_at = NULL
WHERE data_root = @data_root

-- selectExpiredUnconfirmedPlacements
SELECT data_root, relative_offset, chunk_size
FROM chunk_placements
WHERE confirmed_at IS NULL
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
