ALTER TABLE bundle_formats RENAME COLUMN format TO name;

DROP TABLE IF EXISTS bundles;

CREATE TABLE IF NOT EXISTS bundles (
  id BLOB PRIMARY KEY,
  format INTEGER NOT NULL,
  data_item_count INTEGER NOT NULL,
  first_processed_at INTEGER NOT NULL,
  last_processed_at INTEGER NOT NULL
);
