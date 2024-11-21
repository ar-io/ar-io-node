-- selectBundleStats
SELECT
  COUNT(*) AS count,
  IFNULL(SUM(data_item_count), 0) AS data_item_count,
  IFNULL(SUM(matched_data_item_count), 0) AS matched_data_item_count,
  IFNULL(MAX(last_queued_at), -1) AS max_queued_at,
  IFNULL(MAX(last_skipped_at), -1) AS max_skipped_at,
  IFNULL(MAX(last_unbundled_at), -1) AS max_unbundled_at,
  IFNULL(MAX(last_fully_indexed_at), -1) AS max_fully_indexed_at
FROM bundles

-- selectDataItemStats
SELECT
  SUM(data_item_count) AS data_item_count,
  SUM(nested_data_item_count) AS nested_data_item_count,
  MAX(max_new_indexed_at) AS max_new_indexed_at,
  MAX(max_stable_indexed_at) AS max_stable_indexed_at,
  IFNULL(MIN(min_new_height), -1) AS min_new_height,
  IFNULL(MIN(min_stable_height), -1) AS min_stable_height,
  IFNULL(MAX(max_new_height), -1) AS max_new_height,
  IFNULL(MAX(max_stable_height), -1) AS max_stable_height
FROM (
  SELECT
    COUNT(*) AS data_item_count,
    SUM(
      CASE
        WHEN parent_id != root_transaction_id THEN 1
        ELSE 0
      END
    ) AS nested_data_item_count,
    IFNULL(MAX(indexed_at), -1) AS max_new_indexed_at,
    null AS max_stable_indexed_at,
    MIN(height) AS min_new_height,
    null AS min_stable_height,
    MAX(height) AS max_new_height,
    null AS max_stable_height
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
    IFNULL(MAX(indexed_at), -1) AS max_stable_indexed_at,
    null AS min_new_height,
    MIN(height) AS min_stable_height,
    null AS max_new_height,
    MAX(height) AS max_stable_height
  FROM stable_data_items
)
