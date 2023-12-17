DROP INDEX new_transactions_indexed_at_idx;
CREATE INDEX IF NOT EXISTS new_transactions_height_indexed_at_idx ON new_transactions (height, indexed_at);
