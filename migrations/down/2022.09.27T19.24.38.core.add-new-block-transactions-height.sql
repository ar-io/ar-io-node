DROP INDEX new_block_transactions_height_transaction_id_idx;

ALTER TABLE new_block_transactions DROP COLUMN height;
