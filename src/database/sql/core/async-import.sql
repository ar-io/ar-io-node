-- insertAsyncNewBlockTransaction
INSERT INTO new_block_transactions (
  block_indep_hash, transaction_id, block_transaction_index
)
SELECT block_indep_hash, transaction_id, block_transaction_index
FROM stable_block_transactions
WHERE transaction_id = @transaction_id
ON CONFLICT DO NOTHING

-- insertAsyncNewBlockHeight
INSERT INTO new_block_heights (
  height, block_indep_hash
)
SELECT sb.height, sb.indep_hash
FROM stable_block_transactions sbt
JOIN stable_blocks sb ON sb.indep_hash = sbt.block_indep_hash
WHERE sbt.transaction_id = @transaction_id
ON CONFLICT DO NOTHING

-- deleteMissingTransaction
DELETE FROM missing_transactions
WHERE transaction_id = @transaction_id
