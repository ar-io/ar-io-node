-- selectDataAttributes
SELECT *
FROM (
  SELECT
    data_root,
    data_size,
    content_type,
    content_encoding,
    null AS root_transaction_id,
    true AS stable,
    null AS root_parent_offset,
    null AS data_offset
  FROM stable_transactions
  WHERE id = @id
  UNION
  SELECT
    data_root,
    data_size,
    content_type,
    content_encoding,
    null AS root_transaction_id,
    false AS stable,
    null AS root_parent_offset,
    null AS data_offset
  FROM new_transactions
  WHERE id = @id
  UNION
  SELECT
    null AS data_root,
    data_size,
    content_type,
    content_encoding,
    root_transaction_id,
    true AS stable,
    root_parent_offset,
    data_offset
  FROM bundles.stable_data_items
  WHERE id = @id
  UNION
  SELECT
    null AS data_root,
    data_size,
    content_type,
    content_encoding,
    root_transaction_id,
    false AS stable,
    root_parent_offset,
    data_offset
  FROM bundles.new_data_items
  WHERE id = @id
)
LIMIT 1;

-- selectRootTxId
SELECT COALESCE(
  (SELECT root_transaction_id FROM bundles.stable_data_items WHERE id = @id),
  (SELECT root_transaction_id FROM bundles.new_data_items WHERE id = @id),
  (SELECT id FROM stable_transactions WHERE id = @id),
  (SELECT id FROM new_transactions WHERE id = @id)
) AS root_transaction_id,
COALESCE(
  (SELECT content_type FROM bundles.stable_data_items WHERE id = @id),
  (SELECT content_type FROM bundles.new_data_items WHERE id = @id)
) AS content_type,
COALESCE(
  (SELECT data_size FROM bundles.stable_data_items WHERE id = @id),
  (SELECT data_size FROM bundles.new_data_items WHERE id = @id)
) AS data_size;
