-- selectNewDataItemTags
SELECT name, value
FROM new_data_item_tags
JOIN tag_names ON tag_name_hash = tag_names.hash
JOIN tag_values ON tag_value_hash = tag_values.hash
WHERE data_item_id = @id
ORDER BY data_item_tag_index ASC

-- selectStableDataItemTags
SELECT name, value
FROM stable_data_item_tags
JOIN tag_names ON tag_name_hash = tag_names.hash
JOIN tag_values ON tag_value_hash = tag_values.hash
WHERE data_item_id = @id
ORDER BY data_item_tag_index ASC
