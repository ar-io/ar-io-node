DROP INDEX new_transaction_tags_height_indexed_at_idx;

ALTER TABLE new_transaction_tags DROP COLUMN indexed_at;
ALTER TABLE new_transaction_tags DROP COLUMN height;
