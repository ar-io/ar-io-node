-- selectBundleStats
SELECT
  COUNT(*) AS count,
  COALESCE(SUM(data_item_count), 0) AS data_item_count,
  COALESCE(SUM(matched_data_item_count), 0) AS matched_data_item_count,
  COALESCE(MAX(last_queued_at), -1) AS max_queued_at,
  COALESCE(MAX(last_skipped_at), -1) AS max_skipped_at,
  COALESCE(MAX(last_unbundled_at), -1) AS max_unbundled_at,
  COALESCE(MAX(last_fully_indexed_at), -1) AS max_fully_indexed_at
FROM bundles;

-- selectDataItemStats
SELECT
  SUM(data_item_count) AS data_item_count,
  SUM(nested_data_item_count) AS nested_data_item_count,
  MAX(max_new_indexed_at) AS max_new_indexed_at,
  MAX(max_stable_indexed_at) AS max_stable_indexed_at
FROM (
  SELECT
    COUNT(*) AS data_item_count,
    SUM(
      CASE
        WHEN parent_id != root_transaction_id THEN 1
        ELSE 0
      END
    ) AS nested_data_item_count,
    COALESCE(MAX(indexed_at), -1) AS max_new_indexed_at,
    -1 AS max_stable_indexed_at
  FROM new_data_items
  UNION ALL
  SELECT
    COUNT(*) AS bundle_data_item_count,
    SUM(
      CASE
        WHEN parent_id != root_transaction_id THEN 1
        ELSE 0
      END
    ) AS bundle_data_item_nested_count,
    -1 AS max_new_indexed_at,
    COALESCE(MAX(indexed_at), -1) AS max_stable_indexed_at
  FROM stable_data_items
) as ndisdi
