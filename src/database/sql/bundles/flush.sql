-- insertOrIgnoreStableDataItems
INSERT INTO stable_data_items (
  id, parent_id, root_transaction_id,
  height, block_transaction_index,
  signature, anchor, owner_address, target,
  data_offset, data_size, content_type,
  tag_count, indexed_at, signature_type
) SELECT
  ndi.id, ndi.parent_id, ndi.root_transaction_id,
  ndi.height, sbt.block_transaction_index,
  ndi.signature, ndi.anchor, ndi.owner_address, ndi.target,
  ndi.data_offset, ndi.data_size, ndi.content_type,
  ndi.tag_count, ndi.indexed_at, ndi.signature_type
FROM new_data_items ndi
JOIN core.stable_block_transactions sbt
  ON ndi.root_transaction_id = sbt.transaction_id
WHERE ndi.height < @end_height
ON CONFLICT DO NOTHING

-- insertOrIgnoreStableDataItemTags
INSERT INTO stable_data_item_tags (
  tag_name_hash, tag_value_hash,
  height, block_transaction_index,
  data_item_tag_index, data_item_id,
  parent_id, root_transaction_id
) SELECT
  ndit.tag_name_hash, ndit.tag_value_hash,
  ndit.height, sbt.block_transaction_index,
  ndit.data_item_tag_index, ndit.data_item_id,
  ndi.parent_id, ndit.root_transaction_id
FROM new_data_item_tags ndit
JOIN new_data_items ndi
  ON ndit.data_item_id = ndi.id
JOIN core.stable_block_transactions sbt
  ON ndit.root_transaction_id = sbt.transaction_id
WHERE ndit.height < @end_height
ON CONFLICT DO NOTHING
