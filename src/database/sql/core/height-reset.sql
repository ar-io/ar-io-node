-- clearHeightsOnNewBlocks
UPDATE new_blocks
SET height = NULL
WHERE height > @height

-- clearHeightsOnNewBlockTransactions
UPDATE new_block_transactions
SET height = NULL
WHERE height > @height

-- truncateNewBlockHeightsAt
DELETE FROM new_block_heights
WHERE height > @height
