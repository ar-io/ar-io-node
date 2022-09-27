ALTER TABLE new_block_transactions ADD COLUMN height INTEGER;

CREATE INDEX IF NOT EXISTS new_block_transactions_height_transaction_id_idx ON new_block_transactions (height, transaction_id);
