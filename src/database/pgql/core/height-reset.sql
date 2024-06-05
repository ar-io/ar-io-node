-- clearHeightsOnNewTransactions
UPDATE new_transactions
SET height = NULL
WHERE height > @height
  AND EXISTS (SELECT 1 FROM new_transactions WHERE height > @height FOR UPDATE);

-- clearHeightsOnNewTransactionTags
UPDATE new_transaction_tags
SET height = NULL
WHERE height > @height
  AND EXISTS (SELECT 1 FROM new_transaction_tags WHERE height > @height FOR UPDATE);

-- truncateNewBlocksAt
DELETE FROM new_blocks
WHERE height > @height
  AND EXISTS (SELECT 1 FROM new_blocks WHERE height > @height FOR UPDATE);

-- truncateNewBlockTransactionsAt
DELETE FROM new_block_transactions
WHERE height > @height
  AND EXISTS (SELECT 1 FROM new_block_transactions WHERE height > @height FOR UPDATE);

-- truncateMissingTransactionsAt
DELETE FROM missing_transactions
WHERE height > @height
  AND EXISTS (SELECT 1 FROM missing_transactions WHERE height > @height FOR UPDATE);
