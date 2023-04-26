-- insertDataHash
INSERT INTO contiguous_data (
  hash,
  data_size,
  original_source_content_type,
  indexed_at,
  cached_at
) VALUES (
  :hash,
  :data_size,
  :original_source_content_type,
  :indexed_at,
  :cached_at
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

-- selectDataAttributes
SELECT
  cd.hash,
  cd.data_size,
  cd.original_source_content_type,
  cdi.verified
FROM contiguous_data cd
LEFT JOIN contiguous_data_ids cdi ON cdi.contiguous_data_hash = cd.hash
LEFT JOIN data_roots dr ON dr.contiguous_data_hash = cd.hash
WHERE cdi.id = :id OR dr.data_root = :data_root
LIMIT 1

-- selectDataParent
SELECT
  cdip.parent_id,
  cd.hash AS parent_hash,
  cdip.data_offset,
  cdip.data_size
FROM contiguous_data_id_parents cdip
JOIN contiguous_data_ids cdi ON cdip.parent_id = cdi.id
JOIN contiguous_data cd ON cd.hash = cdi.contiguous_data_hash
WHERE cdip.id = :id
LIMIT 1
