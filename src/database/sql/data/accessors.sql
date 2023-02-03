-- insertDataHash
INSERT INTO contiguous_data (
  hash
) VALUES (
  :hash
)

-- insertDataId
INSERT OR REPLACE INTO contiguous_data_ids (
  id,
  contiguous_data_hash
) VALUES (
  :id,
  :contiguous_data_hash
)

-- selectDataIdHash
SELECT contiguous_data_hash
FROM contiguous_data_ids
WHERE id = :id
