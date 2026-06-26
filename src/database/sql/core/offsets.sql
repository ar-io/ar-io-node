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
-- Resolve an absolute weave offset to its containing stable block: the lowest
-- block whose cumulative weave_size reaches the offset. prev_weave_size is the
-- preceding block's cumulative weave_size, used by the caller to confirm the
-- offset is tightly bracketed (no missing block between) before trusting the
-- local result. Backed by stable_blocks_weave_size_idx.
SELECT b.height AS height,
  b.weave_size AS weave_size,
  p.weave_size AS prev_weave_size
FROM stable_blocks b
LEFT JOIN stable_blocks p ON p.height = b.height - 1
WHERE b.weave_size >= @offset
ORDER BY b.weave_size ASC, b.height ASC
LIMIT 1;