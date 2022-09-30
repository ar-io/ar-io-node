DROP INDEX new_transaction_tags_height_created_at_idx;

ALTER TABLE new_transaction_tags DROP COLUMN created_at;
ALTER TABLE new_transaction_tags DROP COLUMN height;
