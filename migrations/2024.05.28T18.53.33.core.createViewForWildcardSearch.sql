-- up migration
CREATE INDEX IF NOT EXISTS tag_names_index ON tag_names (hash, name);
CREATE INDEX IF NOT EXISTS tag_values_index ON tag_values (hash, value);
CREATE INDEX IF NOT EXISTS new_transaction_tags_index ON new_transaction_tags (transaction_id, tag_name_hash, tag_value_hash);
CREATE INDEX IF NOT EXISTS stable_transaction_tags_index ON stable_transaction_tags (transaction_id, tag_name_hash, tag_value_hash);
CREATE INDEX IF NOT EXISTS new_blocks_index ON new_blocks (height);
CREATE INDEX IF NOT EXISTS stable_blocks_index ON stable_blocks (height);
