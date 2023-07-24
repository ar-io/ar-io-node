-- selectBundleStats
SELECT
  COUNT(*) AS count,
  IFNULL(SUM(data_item_count), 0) AS data_item_count,
  IFNULL(SUM(matched_data_item_count), 0) AS matched_data_item_count
FROM bundles

-- selectDataItemStats
SELECT
  SUM(data_item_count) AS data_item_count,
  SUM(nested_data_item_count) AS nested_data_item_count,
  MAX(max_new_indexed_at) AS last_new_indexed_at,
  MAX(max_stable_indexed_at) AS last_stable_indexed_at
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
    IFNULL(MAX(indexed_at), -1) AS max_stable_indexed_at
  FROM stable_data_items
)
