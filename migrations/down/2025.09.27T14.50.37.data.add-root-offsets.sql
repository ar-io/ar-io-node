-- Rollback migration: Remove root_data_item_offset and root_data_offset columns from contiguous_data_ids table

ALTER TABLE contiguous_data_ids DROP COLUMN root_data_item_offset;
ALTER TABLE contiguous_data_ids DROP COLUMN root_data_offset;