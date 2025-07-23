-- up migration
-- Add bundle metadata columns to contiguous_data_ids table

-- Add columns for tracking bundle hierarchy and data locations
ALTER TABLE contiguous_data_ids ADD COLUMN root_transaction_id BLOB;
ALTER TABLE contiguous_data_ids ADD COLUMN root_parent_offset INTEGER;
ALTER TABLE contiguous_data_ids ADD COLUMN data_offset INTEGER;
ALTER TABLE contiguous_data_ids ADD COLUMN data_size INTEGER;
ALTER TABLE contiguous_data_ids ADD COLUMN data_item_offset INTEGER;
ALTER TABLE contiguous_data_ids ADD COLUMN data_item_size INTEGER;
ALTER TABLE contiguous_data_ids ADD COLUMN format_id INTEGER;