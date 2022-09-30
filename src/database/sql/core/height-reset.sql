-- clearHeightsOnNewTransactions
UPDATE new_transactions
SET height = NULL
WHERE height > @height

-- clearHeightsOnNewTransactionTags
UPDATE new_transaction_tags
SET height = NULL
WHERE height > @height

-- truncateNewBlocksAt
DELETE FROM new_blocks
WHERE height > @height

-- truncateNewBlockTransactionsAt
DELETE FROM new_block_transactions
WHERE height > @height

-- truncateMissingTransactionsAt
DELETE FROM missing_transactions
WHERE height > @height
