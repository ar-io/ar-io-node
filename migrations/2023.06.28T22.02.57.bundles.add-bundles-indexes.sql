CREATE INDEX IF NOT EXISTS bundles_last_queued_at_idx
  ON bundles (last_queued_at);
CREATE INDEX IF NOT EXISTS bundles_last_skipped_at_idx
  ON bundles (last_skipped_at);
CREATE INDEX IF NOT EXISTS bundles_last_fully_indexed_at_idx
  ON bundles (last_fully_indexed_at);
CREATE INDEX IF NOT EXISTS bundles_matched_data_item_count_idx
  ON bundles (matched_data_item_count);
CREATE INDEX IF NOT EXISTS bundles_unbundle_filter_id_idx
  ON bundles (unbundle_filter_id);
CREATE INDEX IF NOT EXISTS bundles_index_filter_id_idx
  ON bundles (index_filter_id);

CREATE INDEX IF NOT EXISTS bundle_data_items_parent_id_filter_id_idx
  ON bundle_data_items (parent_id, filter_id);
