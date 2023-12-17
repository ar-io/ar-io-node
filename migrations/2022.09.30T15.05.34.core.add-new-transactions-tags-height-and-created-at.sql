ALTER TABLE new_transaction_tags ADD COLUMN height INTEGER;
ALTER TABLE new_transaction_tags ADD COLUMN indexed_at INTEGER;

CREATE INDEX new_transaction_tags_height_indexed_at_idx ON new_transaction_tags (height, indexed_at);
