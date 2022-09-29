-- clearHeightsOnNewTransactions
UPDATE new_transactions
SET height = NULL
WHERE height > @height

-- truncateNewBlocksAt
DELETE FROM new_blocks
WHERE height > @height

-- truncateNewBlockTransactionsAt
DELETE FROM new_block_transactions
WHERE height > @height
