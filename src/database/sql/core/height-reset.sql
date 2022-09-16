-- truncateNewBlockHeightsAt
DELETE FROM new_block_heights
WHERE height > @height
