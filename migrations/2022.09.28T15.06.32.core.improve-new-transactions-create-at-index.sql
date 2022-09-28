DROP INDEX new_transactions_created_at_idx;
CREATE INDEX IF NOT EXISTS new_transactions_height_created_at_idx ON new_transactions (height, created_at);
