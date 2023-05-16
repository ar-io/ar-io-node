-- selectMissingTransactionHeight
SELECT height
FROM missing_transactions
WHERE transaction_id = @transaction_id

-- insertAsyncNewBlockTransaction
INSERT INTO new_block_transactions (
  block_indep_hash, transaction_id, block_transaction_index,
  height
)
SELECT sbt.block_indep_hash, sbt.transaction_id, sbt.block_transaction_index,
  mt.height
FROM stable_block_transactions sbt
JOIN missing_transactions mt ON mt.transaction_id = sbt.transaction_id
WHERE sbt.transaction_id = @transaction_id
ON CONFLICT DO NOTHING

-- deleteNewMissingTransaction
DELETE FROM missing_transactions
WHERE transaction_id = @transaction_id
  AND height > (
    SELECT MAX(height)+1
    FROM stable_blocks
  )

-- selectTransactionHeight
SELECT height
FROM new_transactions
WHERE id = @transaction_id AND height IS NOT NULL
UNION
SELECT height
FROM stable_transactions
WHERE id = @transaction_id AND height IS NOT NULL
UNION
SELECT height
FROM missing_transactions
WHERE transaction_id = @transaction_id
LIMIT 1
