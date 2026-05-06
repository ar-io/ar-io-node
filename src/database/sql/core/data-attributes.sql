-- selectDataAttributes
-- parent_id is NULL for L1 transactions (they have no parent — they ARE
-- the root) and the immediate parent bundle for data items. Surfaced so
-- the response handler can emit X-AR-IO-Root-Path for the single-level
-- case (parent_id == root_transaction_id), unblocking the cache-and-
-- replay pattern for clients without trusting them to compute the path.
SELECT *
FROM (
  SELECT
    data_root,
    data_size,
    content_type,
    content_encoding,
    null AS root_transaction_id,
    null AS parent_id,
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
    null AS parent_id,
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
    parent_id,
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
    parent_id,
    false AS stable,
    root_parent_offset,
    data_offset
  FROM bundles.new_data_items
  WHERE id = @id
)
LIMIT 1;

-- selectRootTxId
SELECT *
FROM (
  SELECT
    root_transaction_id,
    content_type,
    data_size
  FROM bundles.stable_data_items
  WHERE id = @id
  UNION
  SELECT
    root_transaction_id,
    content_type,
    data_size
  FROM bundles.new_data_items
  WHERE id = @id
  UNION
  SELECT
    id AS root_transaction_id,
    NULL AS content_type,
    NULL AS data_size
  FROM stable_transactions
  WHERE id = @id
  UNION
  SELECT
    id AS root_transaction_id,
    NULL AS content_type,
    NULL AS data_size
  FROM new_transactions
  WHERE id = @id
)
LIMIT 1;
