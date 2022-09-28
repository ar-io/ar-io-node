-- deleteStaleNewTransactionTags
DELETE FROM new_transaction_tags
WHERE transaction_id IN (
  SELECT nt.id
  FROM new_transactions nt
  WHERE nt.height < @height_threshold OR (
      nt.height IS NULL
      AND nt.created_at < @created_at_threshold
    )
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

-- deleteStaleNewBlockHeights
DELETE FROM new_block_heights
WHERE height < @height_threshold

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
