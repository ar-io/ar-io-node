DROP TABLE IF EXISTS bundle_data_items;

CREATE TABLE IF NOT EXISTS bundle_data_items (
  id BLOB NOT NULL,
  parent_id BLOB NOT NULL,
  parent_index INTEGER NOT NULL,
  filter_id INTEGER NOT NULL,
  root_transaction_id BLOB NOT NULL,
  first_indexed_at INTEGER NOT NULL,
  last_indexed_at INTEGER NOT NULL,
  PRIMARY KEY (id, parent_id, parent_index, filter_id)
);

CREATE INDEX IF NOT EXISTS bundle_data_items_filter_id_idx
  ON bundle_data_items (filter_id);
