-- selectStableTransactionOffsetById
SELECT id, data_root, offset, data_size
FROM stable_transactions
WHERE offset >= @offset
  AND (offset - data_size) < @offset
  AND format = 2
  AND data_size > 0
ORDER BY offset ASC
LIMIT 1;

-- selectBlockHeightByWeaveOffset
-- Resolve an absolute weave offset to its containing block: the lowest block
-- whose cumulative weave_size reaches the offset, considering BOTH the stable
-- chain (stable_blocks) and the not-yet-stable tip (new_blocks). Extending the
-- search into new_blocks lets tip offsets resolve from the local index instead
-- of falling through to the slow chain binary search.
--
-- Each table is probed independently through its own weave_size index (a single
-- indexed LIMIT 1 lookup, no full scan of either table), then the two candidates
-- are merged and the lower one chosen. is_unstable flags whether the winning row
-- came from new_blocks (1) or stable_blocks (0); ties prefer the stable row so a
-- block that has just stabilized is reported as stable. The caller uses it to
-- attribute the resolution to the stable vs unstable zone in metrics.
--
-- prev_weave_size is the immediately-preceding block's cumulative weave_size --
-- the MAX across any rows at height-1 in either table. Taking the MAX is the
-- conservative choice under tip forks (new_blocks can transiently hold
-- non-canonical blocks, so weave_size is not guaranteed unique/monotonic there):
-- if any block at height-1 already reaches the offset the bracket is not tight
-- and the caller falls back rather than risk a wrong block. The caller confirms
-- prev_weave_size < offset <= weave_size (a tight bracket, no missing block
-- between) and re-fetches + re-verifies the candidate block before trusting it,
-- so a stale or forked local hit degrades to a fallback, never to wrong bytes.
-- Backed by stable_blocks_weave_size_idx / new_blocks_weave_size_idx.
WITH candidate AS (
  SELECT height, weave_size, 0 AS is_unstable FROM (
    SELECT height, weave_size
    FROM stable_blocks
    WHERE weave_size >= @offset
    ORDER BY weave_size ASC, height ASC
    LIMIT 1
  )
  UNION ALL
  SELECT height, weave_size, 1 AS is_unstable FROM (
    SELECT height, weave_size
    FROM new_blocks
    WHERE weave_size >= @offset
    ORDER BY weave_size ASC, height ASC
    LIMIT 1
  )
)
SELECT c.height AS height,
  c.weave_size AS weave_size,
  c.is_unstable AS is_unstable,
  (
    SELECT MAX(p.weave_size)
    FROM (
      SELECT weave_size FROM stable_blocks WHERE height = c.height - 1
      UNION ALL
      SELECT weave_size FROM new_blocks WHERE height = c.height - 1
    ) AS p
  ) AS prev_weave_size
FROM candidate c
ORDER BY c.weave_size ASC, c.height ASC, c.is_unstable ASC
LIMIT 1;