-- Add root_data_item_offset and root_data_offset columns to contiguous_data_ids table
-- These fields store the offsets returned from Turbo's /offsets endpoint
-- root_data_item_offset: The offset of the data item within the root bundle
-- root_data_offset: The offset of the data item's payload data within the root bundle

ALTER TABLE contiguous_data_ids ADD COLUMN root_data_item_offset INTEGER;
ALTER TABLE contiguous_data_ids ADD COLUMN root_data_offset INTEGER;