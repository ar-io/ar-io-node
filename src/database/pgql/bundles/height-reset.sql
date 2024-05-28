-- clearHeightsOnNewDataItems
UPDATE new_data_items
SET height = NULL
WHERE height > @height
  AND EXISTS (SELECT 1 FROM new_data_items WHERE height > @height FOR UPDATE);

-- clearHeightsOnNewDataItemTags
UPDATE new_data_item_tags
SET height = NULL
WHERE height > @height
  AND EXISTS (SELECT 1 FROM new_data_item_tags WHERE height > @height FOR UPDATE);
