DROP TABLE new_data_items;

CREATE TABLE new_data_items (
  -- Identity
  id BLOB NOT NULL,
  parent_id BLOB,
  root_transaction_id BLOB,
  height INTEGER,
  signature BLOB NOT NULL,
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
  PRIMARY KEY (id)
);

CREATE INDEX new_data_items_parent_id_id_idx ON new_data_items (parent_id, id);
CREATE INDEX new_data_items_root_transaction_id_id_idx ON new_data_items (root_transaction_id, id);
CREATE INDEX new_data_items_target_id_idx ON new_data_items (target, id);
CREATE INDEX new_data_items_owner_address_id_idx ON new_data_items (owner_address, id);
CREATE INDEX new_data_items_height_indexed_at_idx ON new_data_items (height, indexed_at);

DROP TABLE new_data_item_tags;

CREATE TABLE new_data_item_tags (
  tag_name_hash BLOB NOT NULL,
  tag_value_hash BLOB NOT NULL,
  root_transaction_id BLOB,
  data_item_id BLOB NOT NULL,
  data_item_tag_index INTEGER NOT NULL,
  height INTEGER,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (tag_name_hash, tag_value_hash, root_transaction_id, data_item_id, data_item_tag_index)
);

CREATE INDEX new_data_item_tags_height_indexed_at_idx ON new_data_item_tags (height, indexed_at);
CREATE INDEX new_data_item_tags_data_item_id_idx ON new_data_item_tags (data_item_id);
