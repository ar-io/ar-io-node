-- deleteStaleMissingTransactions
DELETE FROM missing_transactions
WHERE height < @height_threshold AND
  EXISTS (
    SELECT 1
    FROM stable_transactions st
    WHERE st.id = missing_transactions.transaction_id
  )

-- deleteStaleNewTransactionTags
DELETE FROM new_transaction_tags
WHERE height < @height_threshold OR (
    height IS NULL AND
    created_at < @created_at_threshold
  )

-- deleteStaleNewTransactions
DELETE FROM new_transactions
WHERE height < @height_threshold OR (
    height IS NULL
    AND created_at < @created_at_threshold
  )

-- deleteStaleNewBlockTransactions
DELETE FROM new_block_transactions
WHERE height < @height_threshold

-- deleteStaleNewBlocks
DELETE FROM new_blocks
WHERE height < @height_threshold
