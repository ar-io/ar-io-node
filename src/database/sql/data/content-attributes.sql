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
WITH ParentStatus AS (
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM contiguous_data_ids AS parent
      WHERE parent.id = :parent_id
      AND parent.verified = 1
    ) THEN 1
    ELSE :verified
  END AS verified_status
)
INSERT INTO contiguous_data_ids (
  id,
  contiguous_data_hash,
  verified,
  indexed_at,
  verified_at,
  verification_priority,
  root_transaction_id,
  root_parent_offset,
  data_offset,
  data_size,
  data_item_offset,
  data_item_size,
  format_id,
  root_data_item_offset,
  root_data_offset
)
SELECT
  :id,
  :contiguous_data_hash,
  verified_status,
  :indexed_at,
  CASE
    WHEN verified_status = 1 THEN :verified_at
    ELSE NULL
  END,
  :verification_priority,
  :root_transaction_id,
  :root_parent_offset,
  :data_offset,
  :data_size,
  :data_item_offset,
  :data_item_size,
  :format_id,
  :root_data_item_offset,
  :root_data_offset
FROM ParentStatus
WHERE
  NOT EXISTS (
    SELECT 1
    FROM contiguous_data_ids
    WHERE id = :id AND verified = 1
  )
ON CONFLICT(id) DO UPDATE SET
  contiguous_data_hash = excluded.contiguous_data_hash,
  verified = excluded.verified,
  indexed_at = excluded.indexed_at,
  verified_at = excluded.verified_at,
  verification_priority = COALESCE(:verification_priority, contiguous_data_ids.verification_priority),
  root_transaction_id = excluded.root_transaction_id,
  root_parent_offset = excluded.root_parent_offset,
  data_offset = excluded.data_offset,
  data_size = excluded.data_size,
  data_item_offset = excluded.data_item_offset,
  data_item_size = excluded.data_item_size,
  format_id = excluded.format_id,
  root_data_item_offset = excluded.root_data_item_offset,
  root_data_offset = excluded.root_data_offset
WHERE contiguous_data_ids.verified != 1;

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
    cdi.verified,
    cdi.root_transaction_id,
    cdi.root_parent_offset,
    cdi.data_offset,
    cdi.data_size,
    cdi.data_item_offset,
    cdi.data_item_size,
    cdi.format_id,
    cdi.root_data_item_offset,
    cdi.root_data_offset
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
    cdi.verified,
    cdi.root_transaction_id,
    cdi.root_parent_offset,
    cdi.data_offset,
    cdi.data_size,
    cdi.data_item_offset,
    cdi.data_item_size,
    cdi.format_id,
    cdi.root_data_item_offset,
    cdi.root_data_offset
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

-- selectRootTransactionId
SELECT root_transaction_id, root_parent_offset, data_offset, data_size, data_item_size, data_item_offset, root_data_item_offset, root_data_offset
FROM contiguous_data_ids
WHERE id = :id
LIMIT 1
