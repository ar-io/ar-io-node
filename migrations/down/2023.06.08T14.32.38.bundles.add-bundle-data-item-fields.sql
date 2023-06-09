DROP TABLE IF EXISTS bundle_data_items;

CREATE TABLE IF NOT EXISTS bundle_data_items (
  id BLOB,
  parent_id BLOB NOT NULL,
  root_transaction_id BLOB NOT NULL,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (id, parent_id)
);
