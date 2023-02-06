-- insertDataHash
INSERT INTO contiguous_data (
  hash,
  data_size,
  original_source_content_type,
  created_at
) VALUES (
  :hash,
  :data_size,
  :original_source_content_type,
  :created_at
) ON CONFLICT DO NOTHING

-- insertDataId
INSERT OR REPLACE INTO contiguous_data_ids (
  id,
  contiguous_data_hash,
  created_at
) VALUES (
  :id,
  :contiguous_data_hash,
  :created_at
)

-- selectDataIdHash
SELECT contiguous_data_hash, cd.data_size, cd.original_source_content_type
FROM contiguous_data_ids cdi
JOIN contiguous_data cd ON cd.hash = cdi.contiguous_data_hash
WHERE cdi.id = :id
