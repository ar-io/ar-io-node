DROP INDEX IF EXISTS new_data_item_tags_data_item_id_idx;

DROP INDEX IF EXISTS stable_data_item_tags_data_item_id_idx;
CREATE INDEX IF NOT EXISTS stable_data_item_tags_transaction_id_idx ON stable_data_item_tags (data_item_id);
