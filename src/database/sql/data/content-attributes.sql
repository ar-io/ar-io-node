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
  verified,
  indexed_at,
  verified_at
) VALUES (
  :id,
  :contiguous_data_hash,
  :verified,
  :indexed_at,
  :verified_at
)

-- updateVerifiedDataId
UPDATE contiguous_data_ids
  SET
    verified = CASE
      WHEN EXISTS (
        SELECT 1
        FROM contiguous_data_ids AS parent
        WHERE parent.id = :parent_id
        AND parent.verified = TRUE
      ) THEN 1
      ELSE 0
  END,
  verified_at = CASE
      WHEN verified = 1 THEN :verified_at
      ELSE NULL
    END
WHERE
  id = :id;

-- insertDataRoot
INSERT OR REPLACE INTO data_roots (
  data_root,
  contiguous_data_hash,
  verified,
  indexed_at,
  verified_at
) VALUES (
  :data_root,
  :contiguous_data_hash,
  :verified,
  :indexed_at,
  :verified_at
)

-- selectDataAttributes
SELECT *
FROM (
  SELECT
    cd.hash,
    cd.data_size,
    cd.original_source_content_type,
    cdi.verified
  FROM contiguous_data cd
  JOIN contiguous_data_ids cdi ON cdi.contiguous_data_hash = cd.hash
  WHERE cdi.id = :id
  LIMIT 1
)
UNION
SELECT *
FROM (
  SELECT
    cd.hash,
    cd.data_size,
    cd.original_source_content_type,
    cdi.verified
  FROM data_roots dr
  JOIN contiguous_data cd ON dr.contiguous_data_hash = cd.hash
  JOIN contiguous_data_ids cdi ON cdi.contiguous_data_hash = cd.hash
  WHERE dr.data_root = :data_root
  LIMIT 1
)
LIMIT 1

-- selectDataParent
SELECT
  cdip.parent_id,
  cd.hash AS parent_hash,
  cdip.data_offset,
  cdip.data_size
FROM contiguous_data_id_parents cdip
JOIN contiguous_data_ids cdi ON cdip.parent_id = cdi.id
LEFT JOIN contiguous_data cd ON cd.hash = cdi.contiguous_data_hash
WHERE cdip.id = :id
LIMIT 1
