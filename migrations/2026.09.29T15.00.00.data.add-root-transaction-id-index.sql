-- Index contiguous_data_ids by root transaction.
--
-- Background verification marks a verified root transaction and every data
-- item under it with `WHERE id = @id OR root_transaction_id = @id`
-- (updateDataItemVerificationStatus). The query used to get the item IDs from
-- bundles.bundle_data_items, which is indexed. When root_transaction_id moved
-- onto this table (2025.07.23T20.12.40.data.add-bundle-metadata) no index came
-- with it, so each verification scanned the whole table while holding the
-- single data.db writer.
--
-- Partial: only data items have a root transaction. Rows without one never
-- match, and SQLite still uses the index here because
-- `root_transaction_id = @id` implies `root_transaction_id IS NOT NULL`.
CREATE INDEX IF NOT EXISTS contiguous_data_ids_root_transaction_id_idx
  ON contiguous_data_ids (root_transaction_id)
  WHERE root_transaction_id IS NOT NULL;
