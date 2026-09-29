-- insertDataHash
-- `original_source_content_type` is keyed by the data hash, so it is shared by
-- every byte-identical upload and, for items this gateway has not indexed, it
-- is the only content type `selectDataAttributes` can return. Under a plain
-- DO NOTHING the first write was permanent: an item served once with the
-- placeholder `application/octet-stream` (the ANS-104 envelope's own type,
-- which a bundle-range read reports when the item's tags were never read) kept
-- downloading instead of rendering forever, and re-uploading the file could not
-- clear it because the new item hashes to the same row.
--
-- So allow exactly one transition — placeholder to real value — and never the
-- reverse. Genuinely binary data keeps its octet-stream type because the only
-- content type on offer for it is also octet-stream; nothing here can overwrite
-- a specific type with another specific type, so two byte-identical items with
-- conflicting `Content-Type` tags cannot flap the row between them.
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
--
-- The placeholder is matched as a whole media type, not as a prefix: bare, or
-- followed by parameters after a `;` or whitespace. A prefix match would also
-- catch distinct specific types that merely start with the same characters —
-- `application/octet-stream+json` is a structured-suffix type of its own, and
-- treating it as the placeholder would let a later write replace it.
) ON CONFLICT(hash) DO UPDATE SET
  original_source_content_type = excluded.original_source_content_type
WHERE
  excluded.original_source_content_type IS NOT NULL
  AND NOT (
    lower(trim(excluded.original_source_content_type))
      = 'application/octet-stream'
    OR lower(trim(excluded.original_source_content_type))
      LIKE 'application/octet-stream;%'
    OR lower(trim(excluded.original_source_content_type))
      LIKE 'application/octet-stream %'
  )
  AND (
    contiguous_data.original_source_content_type IS NULL
    OR lower(trim(contiguous_data.original_source_content_type))
      = 'application/octet-stream'
    OR lower(trim(contiguous_data.original_source_content_type))
      LIKE 'application/octet-stream;%'
    OR lower(trim(contiguous_data.original_source_content_type))
      LIKE 'application/octet-stream %'
  )

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
  root_data_offset,
  trusted
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
  :root_data_offset,
  :trusted
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
  root_data_offset = excluded.root_data_offset,
  trusted = CASE
    WHEN contiguous_data_ids.trusted = 1 THEN 1
    ELSE excluded.trusted
  END
WHERE contiguous_data_ids.verified != 1;

-- insertDataRoot
-- Guard against empty/NULL data_root. L1 transactions with no data_root
-- (e.g. legacy data txs) would otherwise plant a poison row keyed on the
-- empty value, which selectDataAttributes' fallback branch could then match
-- for any other empty-data_root tx, serving unrelated content. The
-- INSERT ... SELECT ... WHERE form lets callers pass an empty data_root
-- without TS-side changes: the write simply no-ops.
INSERT OR REPLACE INTO data_roots (
  data_root,
  contiguous_data_hash,
  verified,
  indexed_at,
  verified_at
) SELECT
  :data_root,
  :contiguous_data_hash,
  :verified,
  :indexed_at,
  :verified_at
WHERE :data_root IS NOT NULL AND length(:data_root) > 0

-- selectDataAttributes
SELECT *
FROM (
  SELECT
    cd.hash,
    cd.data_size,
    cd.original_source_content_type,
    cdi.verified,
    cdi.trusted,
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
    cdi.trusted,
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
  WHERE :data_root IS NOT NULL
    AND length(:data_root) > 0
    AND dr.data_root = :data_root
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

-- clearDataHash
UPDATE contiguous_data_ids
SET contiguous_data_hash = NULL, trusted = NULL, verified = 0, verified_at = NULL
WHERE id = :id

-- selectRootTransactionId
SELECT root_transaction_id, root_parent_offset, data_offset, data_size, data_item_size, data_item_offset, root_data_item_offset, root_data_offset
FROM contiguous_data_ids
WHERE id = :id
LIMIT 1
