-- deleteStaleMissingTransactions
DELETE FROM missing_transactions
WHERE height < @height_threshold AND
  transaction_id IN (
    SELECT nt.id
    FROM new_transactions nt
    WHERE nt.height < @height_threshold
  )

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
