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
    null AS data_offset,
    height
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
    null AS data_offset,
    height
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
    data_offset,
    height
  FROM bundles.stable_data_items
  WHERE id = @id
  UNION
  -- An item not yet flushed is still stable when its root L1 transaction
  -- is: the item's bytes are in that transaction, which is past the fork
  -- depth. The bundles flush promotes items only once both its own pass and
  -- the core flush have run, and an item whose bundle has no
  -- stable_block_transactions row is never promoted, so the table alone
  -- under-reports stability. The root here is the one our own unbundling
  -- recorded, never a location learned from a peer.
  SELECT
    null AS data_root,
    ndi.data_size,
    ndi.content_type,
    ndi.content_encoding,
    ndi.root_transaction_id,
    ndi.parent_id,
    EXISTS (
      SELECT 1 FROM stable_transactions st
      WHERE st.id = ndi.root_transaction_id
    ) AS stable,
    ndi.root_parent_offset,
    ndi.data_offset,
    ndi.height
  FROM bundles.new_data_items ndi
  WHERE ndi.id = @id
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
