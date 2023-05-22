-- deleteStaleNewDataItems
DELETE FROM new_data_items
WHERE id IN (
  SELECT DISTINCT ndi.id
  FROM new_data_items ndi
  LEFT JOIN core.stable_transactions st
    ON ndi.root_transaction_id = st.id
    AND st.height < @height_threshold
  LEFT JOIN core.missing_transactions mt
    ON ndi.root_transaction_id = mt.transaction_id
    AND mt.height < @height_threshold
)

-- deleteStaleNewDataItemTags
DELETE FROM new_data_item_tags
WHERE data_item_id IN (
  SELECT DISTINCT ndi.id
  FROM new_data_items ndi
  LEFT JOIN core.stable_transactions st
    ON ndi.root_transaction_id = st.id
    AND st.height < @height_threshold
  LEFT JOIN core.missing_transactions mt
    ON ndi.root_transaction_id = mt.transaction_id
    AND mt.height < @height_threshold
)
