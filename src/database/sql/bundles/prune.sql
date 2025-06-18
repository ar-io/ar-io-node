-- deleteStableDataItemTagsWithHeightAndIndexedAt
DELETE FROM stable_data_item_tags
WHERE data_item_id IN (
  SELECT id
  FROM stable_data_items
  WHERE indexed_at < @indexed_at_threshold
    AND height >= @start_height
    AND height <= @end_height
)

-- deleteStableDataItemsWithHeightAndIndexedAt
DELETE FROM stable_data_items
WHERE indexed_at < @indexed_at_threshold
  AND height >= @start_height
  AND height <= @end_height
