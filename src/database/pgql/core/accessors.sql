-- selectMaxHeight
SELECT MAX(height) AS height
FROM (
  SELECT MAX(height) AS height
  FROM new_blocks
  UNION
  SELECT MAX(height) AS height
  FROM stable_blocks
) as m

-- selectBlockHashByHeight
SELECT indep_hash
FROM (
  SELECT indep_hash
  FROM new_blocks
  WHERE height = @height
  UNION
  SELECT indep_hash
  FROM stable_blocks
  WHERE height = @height
) as nbihsbih
LIMIT 1

-- selectMissingTransactionIds
SELECT transaction_id
FROM (
  SELECT transaction_id
  FROM missing_transactions
  LIMIT @limit
) as mtti
ORDER BY RANDOM()
