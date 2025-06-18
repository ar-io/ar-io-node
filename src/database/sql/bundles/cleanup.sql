-- deleteStaleNewDataItems
DELETE FROM new_data_items
WHERE height < @height_threshold OR (
    height IS NULL AND
    indexed_at < @indexed_at_threshold
  )

-- deleteStaleNewDataItemTags
DELETE FROM new_data_item_tags
WHERE height < @height_threshold OR (
    height IS NULL AND
    indexed_at < @indexed_at_threshold
  )

-- deleteStableDataItemsLessThanIndexedAt
DELETE FROM stable_data_items
WHERE indexed_at < @indexed_at_threshold
