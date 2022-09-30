ALTER TABLE new_transaction_tags ADD COLUMN height INTEGER;
ALTER TABLE new_transaction_tags ADD COLUMN created_at INTEGER;

CREATE INDEX new_transaction_tags_height_created_at_idx ON new_transaction_tags (height, created_at);
