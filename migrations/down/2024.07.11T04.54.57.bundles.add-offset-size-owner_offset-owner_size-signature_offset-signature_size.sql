ALTER TABLE new_data_items DROP COLUMN offset;
ALTER TABLE new_data_items DROP COLUMN size;
ALTER TABLE new_data_items DROP COLUMN owner_offset;
ALTER TABLE new_data_items DROP COLUMN owner_size;
ALTER TABLE new_data_items DROP COLUMN signature_offset;
ALTER TABLE new_data_items DROP COLUMN signature_size;

ALTER TABLE stable_data_items DROP COLUMN offset;
ALTER TABLE stable_data_items DROP COLUMN size;
ALTER TABLE stable_data_items DROP COLUMN owner_offset;
ALTER TABLE stable_data_items DROP COLUMN owner_size;
ALTER TABLE stable_data_items DROP COLUMN signature_offset;
ALTER TABLE stable_data_items DROP COLUMN signature_size;
