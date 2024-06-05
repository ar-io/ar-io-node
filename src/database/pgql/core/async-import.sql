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
ON CONFLICT DO NOTHING;

-- deleteNewMissingTransaction
DELETE FROM missing_transactions
WHERE transaction_id = @transaction_id
  AND height > (
    SELECT MAX(height)+1
    FROM stable_blocks
);

-- selectStableTransactionIdsMissingOffsets
SELECT id
FROM stable_transactions
WHERE format = 2
  AND data_size > 0
  AND stable_transactions.offset IS NULL
LIMIT @limit

-- updateStableTransactionOffset
UPDATE stable_transactions
SET "offset" = @offset
WHERE id = @id;
