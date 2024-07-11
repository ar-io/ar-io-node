ALTER TABLE new_data_items ADD COLUMN offset INTEGER;
ALTER TABLE new_data_items ADD COLUMN size INTEGER;
ALTER TABLE new_data_items ADD COLUMN owner_offset INTEGER;
ALTER TABLE new_data_items ADD COLUMN owner_size INTEGER;
ALTER TABLE new_data_items ADD COLUMN signature_offset INTEGER;
ALTER TABLE new_data_items ADD COLUMN signature_size INTEGER;

ALTER TABLE stable_data_items ADD COLUMN offset INTEGER;
ALTER TABLE stable_data_items ADD COLUMN size INTEGER;
ALTER TABLE stable_data_items ADD COLUMN owner_offset INTEGER;
ALTER TABLE stable_data_items ADD COLUMN owner_size INTEGER;
ALTER TABLE stable_data_items ADD COLUMN signature_offset INTEGER;
ALTER TABLE stable_data_items ADD COLUMN signature_size INTEGER;
