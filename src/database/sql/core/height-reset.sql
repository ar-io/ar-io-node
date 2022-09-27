-- clearHeightsOnNewBlocks
UPDATE new_blocks
SET height = NULL
WHERE height > @height

-- truncateNewBlockHeightsAt
DELETE FROM new_block_heights
WHERE height > @height
