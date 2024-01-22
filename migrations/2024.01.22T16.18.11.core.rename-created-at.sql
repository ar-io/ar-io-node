ALTER TABLE new_transactions RENAME created_at TO indexed_at;
DROP INDEX new_transactions_height_created_at_idx;
CREATE INDEX new_transactions_height_indexed_at_idx ON new_transactions (height, indexed_at);

ALTER TABLE new_transaction_tags RENAME created_at TO indexed_at;
DROP INDEX new_transaction_tags_height_created_at_idx;
CREATE INDEX new_transaction_tags_height_indexed_at_idx ON new_transaction_tags (height, indexed_at);
