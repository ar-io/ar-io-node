-- insertDataHash
INSERT INTO contiguous_data (
  hash,
  data_size,
  original_source_content_type,
  indexed_at
) VALUES (
  :hash,
  :data_size,
  :original_source_content_type,
  :indexed_at
) ON CONFLICT DO NOTHING

-- insertDataId
INSERT OR REPLACE INTO contiguous_data_ids (
  id,
  contiguous_data_hash,
  indexed_at
) VALUES (
  :id,
  :contiguous_data_hash,
  :indexed_at
)

-- insertDataRoot
INSERT OR REPLACE INTO data_roots (
  data_root,
  contiguous_data_hash,
  indexed_at
) VALUES (
  :data_root,
  :contiguous_data_hash,
  :indexed_at
)

-- selectDataIdHash
SELECT
  contiguous_data_hash,
  cd.data_size,
  cd.original_source_content_type,
  cdi.verified
FROM contiguous_data_ids cdi
JOIN contiguous_data cd ON cd.hash = cdi.contiguous_data_hash
WHERE cdi.id = :id
