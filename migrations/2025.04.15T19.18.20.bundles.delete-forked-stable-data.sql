-- up migration
DELETE FROM stable_data_item_tags
WHERE data_item_id IN (
  SELECT id FROM stable_data_items
  WHERE height > (
    SELECT MAX(height) - 18
    FROM stable_data_items
  )
);

DELETE FROM stable_data_items
WHERE height > (
  SELECT MAX(height) - 18
  FROM stable_data_items
);
