-- selectStableTransactionOffsetById
SELECT id, data_root, offset, data_size
FROM stable_transactions
WHERE offset >= @offset
  AND (offset - data_size) <= @offset
  AND format = 2
  AND data_size > 0
ORDER BY offset ASC
LIMIT 1;