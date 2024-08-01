CREATE TABLE stable_data_items_new (
  -- Identity
  id BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  root_transaction_id BLOB NOT NULL,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  signature BLOB NOT NULL, -- Changed back to NOT NULL
  anchor BLOB NOT NULL,

  -- Ownership
  owner_address BLOB NOT NULL,
  target BLOB,

  -- Data
  data_offset INTEGER NOT NULL,
  data_size INTEGER NOT NULL,
  content_type TEXT,

  -- Metadata
  tag_count INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  signature_type INTEGER,
  offset INTEGER,
  size INTEGER,
  owner_offset INTEGER,
  owner_size INTEGER,
  signature_offset INTEGER,
  signature_size INTEGER,
  content_encoding TEXT,
  PRIMARY KEY (id)
);

-- Copy data, excluding rows with NULL signatures
INSERT INTO stable_data_items_new 
SELECT * FROM stable_data_items
WHERE signature IS NOT NULL;

DROP TABLE stable_data_items;
ALTER TABLE stable_data_items_new RENAME TO stable_data_items;

CREATE INDEX stable_data_items_height_block_transaction_index_id_idx ON stable_data_items (height, block_transaction_index, id);
CREATE INDEX stable_data_items_target_height_block_transaction_index_id_idx ON stable_data_items (target, height, block_transaction_index, id);
CREATE INDEX stable_data_items_owner_address_height_block_transaction_index_id_idx ON stable_data_items (owner_address, height, block_transaction_index, id);
CREATE INDEX stable_data_items_parent_id_height_block_transaction_index_id_idx ON stable_data_items (parent_id, height, block_transaction_index, id);

-- Modify new_data_items table
CREATE TABLE new_data_items_temp (
  -- Identity
  id BLOB NOT NULL,
  parent_id BLOB,
  root_transaction_id BLOB,
  height INTEGER,
  signature BLOB NOT NULL, -- Changed back to NOT NULL
  anchor BLOB NOT NULL,

  -- Ownership
  owner_address BLOB NOT NULL,
  target BLOB,

  -- Data
  data_offset INTEGER,
  data_size INTEGER NOT NULL,
  content_type TEXT,

  -- Metadata
  tag_count INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  signature_type INTEGER,
  offset INTEGER,
  size INTEGER,
  owner_offset INTEGER,
  owner_size INTEGER,
  signature_offset INTEGER,
  signature_size INTEGER,
  content_encoding TEXT,
  PRIMARY KEY (id)
);

-- Copy data, excluding rows with NULL signatures
INSERT INTO new_data_items_temp 
SELECT * FROM new_data_items
WHERE signature IS NOT NULL;

DROP TABLE new_data_items;
ALTER TABLE new_data_items_temp RENAME TO new_data_items;

CREATE INDEX new_data_items_parent_id_id_idx ON new_data_items (parent_id, id);
CREATE INDEX new_data_items_root_transaction_id_id_idx ON new_data_items (root_transaction_id, id);
CREATE INDEX new_data_items_target_id_idx ON new_data_items (target, id);
CREATE INDEX new_data_items_owner_address_id_idx ON new_data_items (owner_address, id);
CREATE INDEX new_data_items_height_indexed_at_idx ON new_data_items (height, indexed_at);
