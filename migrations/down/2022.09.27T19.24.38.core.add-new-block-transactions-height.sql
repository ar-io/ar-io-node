DROP INDEX new_block_transactions_height_idx;

ALTER TABLE new_block_transactions DROP COLUMN height;
