-- insertOrIgnoreStableDataItems
INSERT INTO stable_data_items (
  id, parent_id, root_transaction_id,
  height,
  block_transaction_index,
  signature, anchor, owner_address, target,
  data_offset, data_size, content_type,
  tag_count, indexed_at
)
SELECT
  ndi.id, ndi.parent_id, ndi.root_transaction_id,
  IFNULL(st.height, mt.height),
  IFNULL(st.block_transaction_index, sbt.block_transaction_index),
  ndi.signature, ndi.anchor, ndi.owner_address, ndi.target,
  ndi.data_offset, ndi.data_size, ndi.content_type,
  ndi.tag_count, ndi.indexed_at
FROM new_data_items ndi
LEFT JOIN core.stable_transactions st
  ON ndi.root_transaction_id = st.id
  AND st.height < @end_height
LEFT JOIN core.missing_transactions mt
  ON ndi.root_transaction_id = mt.transaction_id
  AND mt.height < @end_height
LEFT JOIN core.stable_block_transactions sbt
  ON mt.transaction_id = sbt.transaction_id
ON CONFLICT DO NOTHING

-- insertOrIgnoreStableDataItemTags
INSERT INTO stable_data_item_tags (
  tag_name_hash, tag_value_hash,
  height,
  block_transaction_index,
  data_item_tag_index, data_item_id,
  parent_id, root_transaction_id
) SELECT
  ndit.tag_name_hash, ndit.tag_value_hash,
  IFNULL(st.height, mt.height),
  IFNULL(st.block_transaction_index, sbt.block_transaction_index),
  ndit.data_item_tag_index, ndit.data_item_id,
  ndi.parent_id, ndi.root_transaction_id
FROM new_data_item_tags ndit
JOIN new_data_items ndi ON ndit.data_item_id = ndi.id
LEFT JOIN core.stable_transactions st
  ON ndi.root_transaction_id = st.id
  AND st.height < @end_height
LEFT JOIN core.missing_transactions mt
  ON ndi.root_transaction_id = mt.transaction_id
  AND mt.height < @end_height
LEFT JOIN core.stable_block_transactions sbt
  ON mt.transaction_id = sbt.transaction_id
ON CONFLICT DO NOTHING
