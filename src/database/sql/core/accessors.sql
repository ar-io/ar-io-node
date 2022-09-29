-- selectMaxHeight
SELECT MAX(height) AS height
FROM (
  SELECT MAX(height) AS height
  FROM new_blocks
  UNION
  SELECT MAX(height) AS height
  FROM stable_blocks
)

-- selectNewBlockHashByHeight
SELECT indep_hash
FROM new_blocks
WHERE height = @height

-- selectMissingTransactionIds
SELECT transaction_id
FROM missing_transactions
LIMIT @limit
