DROP TABLE IF EXISTS bundles;

CREATE TABLE IF NOT EXISTS bundles (
  id BLOB PRIMARY KEY,
  format_id INTEGER NOT NULL,
  unbundle_filter_id INTEGER,
  index_filter_id INTEGER,
  data_item_count INTEGER,
  matched_data_item_count INTEGER,
  first_queued_at INTEGER,
  last_queued_at INTEGER,
  first_skipped_at INTEGER,
  last_skipped_at INTEGER,
  first_unbundled_at INTEGER,
  last_unbundled_at INTEGER,
  first_fully_indexed_at INTEGER,
  last_fully_indexed_at INTEGER
);

CREATE INDEX IF NOT EXISTS bundles_format_id_idx ON bundles (format_id);

ALTER TABLE bundle_formats RENAME COLUMN name TO format;
