-- clearHeightsOnNewDataItems
UPDATE new_data_items
SET height = NULL
WHERE height > @height

-- clearHeightsOnNewDataItemTags
UPDATE new_data_item_tags
SET height = NULL
WHERE height > @height
