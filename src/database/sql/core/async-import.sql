-- insertAsyncNewBlockTransaction
INSERT INTO new_block_transactions (
  block_indep_hash, transaction_id, block_transaction_index
)
SELECT block_indep_hash, transaction_id, block_transaction_index
FROM stable_block_transactions
WHERE transaction_id = @transaction_id
ON CONFLICT DO NOTHING

-- deleteMissingTransaction
DELETE FROM missing_transactions
WHERE transaction_id = @transaction_id
