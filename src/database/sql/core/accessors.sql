-- selectMaxHeight
SELECT MAX(height) AS height
FROM (
  SELECT MAX(height) AS height
  FROM new_block_heights
  UNION
  SELECT MAX(height) AS height
  FROM stable_blocks
)

-- selectNewBlockHashByHeight
SELECT block_indep_hash
FROM new_block_heights
WHERE height = @height

-- selectMissingTransactionIds
SELECT transaction_id
FROM missing_transactions
LIMIT @limit
