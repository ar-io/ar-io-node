-- deleteStaleNewTransactionTags
DELETE FROM new_transaction_tags
WHERE transaction_id IN (
  SELECT nbt.transaction_id
  FROM new_block_transactions nbt
  WHERE nbt.height < @height_threshold
)

-- deleteStaleNewTransactionsByHeight
DELETE FROM new_transactions
WHERE id IN (
  SELECT nbt.transaction_id
  FROM new_block_transactions nbt
  WHERE nbt.height < @height_threshold
)

-- deleteStaleNewBlockTransactions
DELETE FROM new_block_transactions
WHERE height < @height_threshold

-- deleteStaleNewBlocks
DELETE FROM new_blocks
WHERE height < @height_threshold

-- deleteStaleNewBlockHeights
DELETE FROM new_block_heights
WHERE height < @height_threshold

-- deleteStaleNewTransactionsByCreatedAt
DELETE FROM new_transactions
WHERE created_at < @created_at_threshold AND
  id NOT IN (
    SELECT transaction_id
    FROM new_block_transactions
  )

-- deleteForkedOutMissingTransactions
DELETE FROM missing_transactions
WHERE transaction_id IN (
  SELECT mt.transaction_id
  FROM missing_transactions mt
  LEFT JOIN stable_block_transactions sbt ON
    sbt.block_indep_hash = mt.block_indep_hash
    AND sbt.transaction_id = mt.transaction_id
  WHERE mt.height < @height_threshold AND sbt.transaction_id IS NULL
)
