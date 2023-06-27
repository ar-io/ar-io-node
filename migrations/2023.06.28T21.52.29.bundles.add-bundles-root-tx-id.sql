ALTER TABLE bundles ADD COLUMN root_transaction_id BLOB;
UPDATE bundles SET root_transaction_id = id;
