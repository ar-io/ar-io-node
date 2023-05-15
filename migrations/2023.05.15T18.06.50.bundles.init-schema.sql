CREATE TABLE IF NOT EXISTS bundle_formats (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL
);

INSERT INTO bundle_formats (id, name) VALUES (0, 'ans-102');
INSERT INTO bundle_formats (id, name) VALUES (1, 'ans-104');

CREATE TABLE IF NOT EXISTS bundles (
  id BLOB PRIMARY KEY,
  format INTEGER NOT NULL,
  data_item_count INTEGER NOT NULL,
  first_processed_at INTEGER NOT NULL,
  last_processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bundle_data_items (
  id BLOB,
  parent_id BLOB NOT NULL,
  root_transaction_id BLOB NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (id, parent_id)
);

CREATE TABLE IF NOT EXISTS wallets (
  address BLOB PRIMARY KEY,
  public_modulus BLOB
);

CREATE TABLE IF NOT EXISTS stable_data_items (
  -- Identity
  id BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  root_transaction_id BLOB NOT NULL,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  signature BLOB NOT NULL,
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
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS stable_data_items_height_block_transaction_index_id_idx ON stable_data_items (height, block_transaction_index, id);
CREATE INDEX IF NOT EXISTS stable_data_items_target_height_block_transaction_index_id_idx ON stable_data_items (target, height, block_transaction_index, id);
CREATE INDEX IF NOT EXISTS stable_data_items_owner_address_height_block_transaction_index_id_idx ON stable_data_items (owner_address, height, block_transaction_index, id);
CREATE INDEX IF NOT EXISTS stable_data_items_parent_id_height_block_transaction_index_id_idx ON stable_data_items (parent_id, height, block_transaction_index, id);

CREATE TABLE IF NOT EXISTS tag_names (
  hash BLOB PRIMARY KEY,
  name BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_values (
  hash BLOB PRIMARY KEY,
  value BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS stable_data_item_tags (
  tag_name_hash BLOB NOT NULL,
  tag_value_hash BLOB NOT NULL,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  data_item_tag_index INTEGER NOT NULL,
  data_item_id BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  root_transaction_id BLOB NOT NULL,
  PRIMARY KEY (tag_name_hash, tag_value_hash, height, block_transaction_index, data_item_id, data_item_tag_index)
);

CREATE INDEX IF NOT EXISTS stable_data_item_tags_transaction_id_idx ON stable_data_item_tags (data_item_id);

CREATE TABLE IF NOT EXISTS new_data_items (
  -- Identity
  id BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  root_transaction_id BLOB NOT NULL,
  height INTEGER,
  signature BLOB NOT NULL,
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
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS new_data_items_parent_id_id_idx ON new_data_items (parent_id, id);
CREATE INDEX IF NOT EXISTS new_data_items_root_transaction_id_id_idx ON new_data_items (root_transaction_id, id);
CREATE INDEX IF NOT EXISTS new_data_items_target_id_idx ON new_data_items (target, id);
CREATE INDEX IF NOT EXISTS new_data_items_owner_address_id_idx ON new_data_items (owner_address, id);
CREATE INDEX IF NOT EXISTS new_data_items_height_indexed_at_idx ON new_data_items (height, indexed_at);

CREATE TABLE IF NOT EXISTS new_data_item_tags (
  tag_name_hash BLOB NOT NULL,
  tag_value_hash BLOB NOT NULL,
  root_transaction_id BLOB NOT NULL,
  data_item_id BLOB NOT NULL,
  data_item_tag_index INTEGER NOT NULL,
  height INTEGER,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (tag_name_hash, tag_value_hash, root_transaction_id, data_item_id, data_item_tag_index)
);

CREATE INDEX IF NOT EXISTS new_data_item_tags_height_indexed_at_idx ON new_data_item_tags (height, indexed_at);
