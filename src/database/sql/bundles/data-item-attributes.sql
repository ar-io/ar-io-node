-- selectDataItemAttributes
SELECT 
  parent_id,
  signature, 
  signature_offset, 
  signature_size 
FROM new_data_items
WHERE id = @id
UNION
SELECT 
  parent_id,
  signature, 
  signature_offset, 
  signature_size 
FROM stable_data_items
WHERE id = @id
LIMIT 1