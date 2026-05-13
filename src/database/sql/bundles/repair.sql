-- selectFailedBundleIds
SELECT DISTINCT id
FROM (
  SELECT b.root_transaction_id AS id
  FROM bundles b
  WHERE (
      (b.last_queued_at IS NULL AND b.last_skipped_at IS NULL)
      OR (
        b.last_queued_at IS NOT NULL
        AND (
          b.last_skipped_at IS NULL
          OR b.last_skipped_at <= b.last_queued_at
        )
        AND b.last_queued_at < @reprocess_cutoff
      )
    )
    AND b.last_fully_indexed_at IS NULL
    AND (
      b.matched_data_item_count IS NULL
      OR b.matched_data_item_count > 0
    )
  ORDER BY b.retry_attempt_count, b.last_retried_at ASC
  LIMIT @limit
)
ORDER BY RANDOM()

-- selectLargeFailedBundleIds
-- Parallel retry lane for already-parsed bundles whose data_item_count is at
-- or above @threshold (Turbo-class bundles with many DIs each). The original
-- selectFailedBundleIds ordering (by retry_attempt_count) gives equal weight
-- to a 2-DI direct ArDrive bundle and a 500-DI Turbo bundle, which means
-- direct bundles dominate the worker pool and large bundles starve. This
-- query targets only the subset where we already know data_item_count >=
-- threshold and orders by size DESC so workers chip away at the largest
-- bundles first. Bundles whose size is not yet known (data_item_count IS
-- NULL) are intentionally excluded — they are handled by selectFailedBundleIds
-- and get their size populated on first unbundle, after which they become
-- eligible for this lane on subsequent retries.
--
-- Backed by bundles_large_active_priority_idx (partial index on
-- (data_item_count, retry_attempt_count, last_retried_at) WHERE
-- last_fully_indexed_at IS NULL AND data_item_count >= 50). The partial
-- WHERE predicate uses the same threshold literal (50) as the default
-- BUNDLE_REPAIR_LARGE_BUNDLE_THRESHOLD env var; lowering the env without
-- recreating the index will still work but the index will only serve the
-- subset >= 50.
SELECT DISTINCT id
FROM (
  SELECT b.root_transaction_id AS id
  FROM bundles b
  WHERE (
      (b.last_queued_at IS NULL AND b.last_skipped_at IS NULL)
      OR (
        b.last_queued_at IS NOT NULL
        AND (
          b.last_skipped_at IS NULL
          OR b.last_skipped_at <= b.last_queued_at
        )
        AND b.last_queued_at < @reprocess_cutoff
      )
    )
    AND b.last_fully_indexed_at IS NULL
    AND b.matched_data_item_count IS NOT NULL
    AND b.matched_data_item_count > 0
    AND b.data_item_count IS NOT NULL
    AND b.data_item_count >= @threshold
  ORDER BY b.data_item_count DESC, b.retry_attempt_count, b.last_retried_at ASC
  LIMIT @limit
)
ORDER BY RANDOM()

-- updateFullyIndexedAt
UPDATE bundles
SET
  first_fully_indexed_at = IFNULL(first_fully_indexed_at, @fully_indexed_at),
  last_fully_indexed_at = @fully_indexed_at
WHERE matched_data_item_count IS NOT NULL
  AND matched_data_item_count > 0
  AND (
    SELECT COUNT(*)
    FROM bundle_data_items bdi
    WHERE bdi.parent_id = bundles.id
      AND bdi.filter_id = bundles.index_filter_id
  ) = bundles.matched_data_item_count
  AND last_fully_indexed_at IS NULL;

-- updateForFilterChange
UPDATE bundles
SET
  last_queued_at = NULL,
  last_skipped_at = NULL,
  last_fully_indexed_at = NULL,
  matched_data_item_count = NULL
WHERE id IN (
  SELECT b.id
  FROM bundles b
  WHERE (
    last_skipped_at IS NOT NULL
    AND (
      (SELECT id FROM filters WHERE filter = @unbundle_filter) IS NULL
      OR unbundle_filter_id != (SELECT id FROM filters WHERE filter = @unbundle_filter)
    )
  ) OR (
    last_queued_at IS NOT NULL
    AND (
      (SELECT id FROM filters WHERE filter = @index_filter) IS NULL
      OR index_filter_id != (SELECT id FROM filters WHERE filter = @index_filter)
    )
  )
  LIMIT 10000
)

--insertMissingBundles
INSERT INTO bundles (
  id,
  root_transaction_id,
  format_id
)
SELECT
  sttf.transaction_id,
  sttf.transaction_id,
  (SELECT id FROM bundle_formats WHERE format = 'ans-104')
FROM stable_transaction_tags sttf
JOIN stable_transaction_tags sttv ON sttv.transaction_id = sttf.transaction_id
  AND sttv.transaction_tag_index != sttf.transaction_tag_index
LEFT JOIN bundles b ON b.id = sttf.transaction_id
WHERE sttf.tag_name_hash = x'BF796ECA81CCE3FF36CEA53FA1EBB0F274A0FF29'
  AND sttf.tag_value_hash = x'7E57CFE843145135AEE1F4D0D63CEB7842093712'
  AND sttv.tag_name_hash = x'858B76CB055E360A2E4C3C38F4A3049F80175216'
  AND sttv.tag_value_hash = x'F7CA6A21D278EB5CE64611AADBDB77EF1511D3DD'
  AND b.id IS NULL
UNION ALL
SELECT
  nttf.transaction_id,
  nttf.transaction_id,
  (SELECT id FROM bundle_formats WHERE format = 'ans-104')
FROM new_transaction_tags nttf
JOIN new_transaction_tags nttv ON nttv.transaction_id = nttf.transaction_id
LEFT JOIN bundles b ON b.id = nttf.transaction_id
WHERE nttf.tag_name_hash = x'BF796ECA81CCE3FF36CEA53FA1EBB0F274A0FF29'
  AND nttf.tag_value_hash = x'7E57CFE843145135AEE1F4D0D63CEB7842093712'
  AND nttv.tag_name_hash = x'858B76CB055E360A2E4C3C38F4A3049F80175216'
  AND nttv.tag_value_hash = x'F7CA6A21D278EB5CE64611AADBDB77EF1511D3DD'
  AND b.id IS NULL
UNION ALL
SELECT
  sdi.id,
  sdi.root_transaction_id,
  (SELECT id FROM bundle_formats WHERE format = 'ans-104')
FROM stable_data_item_tags sdif
JOIN stable_data_item_tags sdiv ON sdiv.data_item_id = sdif.data_item_id
  AND sdiv.data_item_tag_index != sdif.data_item_tag_index
JOIN stable_data_items sdi ON sdi.id = sdif.data_item_id
LEFT JOIN bundles b ON b.id = sdif.data_item_id
WHERE sdif.tag_name_hash = x'BF796ECA81CCE3FF36CEA53FA1EBB0F274A0FF29'
  AND sdif.tag_value_hash = x'7E57CFE843145135AEE1F4D0D63CEB7842093712'
  AND sdiv.tag_name_hash = x'858B76CB055E360A2E4C3C38F4A3049F80175216'
  AND sdiv.tag_value_hash = x'F7CA6A21D278EB5CE64611AADBDB77EF1511D3DD'
  AND b.id IS NULL
UNION ALL
SELECT
  ndi.id,
  ndi.root_transaction_id,
  (SELECT id FROM bundle_formats WHERE format = 'ans-104')
FROM new_data_item_tags ndif
JOIN new_data_item_tags ndiv ON ndiv.data_item_id = ndif.data_item_id
JOIN new_data_items ndi ON ndi.id = ndif.data_item_id
LEFT JOIN bundles b ON b.id = ndif.data_item_id
WHERE ndif.tag_name_hash = x'BF796ECA81CCE3FF36CEA53FA1EBB0F274A0FF29'
  AND ndif.tag_value_hash = x'7E57CFE843145135AEE1F4D0D63CEB7842093712'
  AND ndiv.tag_name_hash = x'858B76CB055E360A2E4C3C38F4A3049F80175216'
  AND ndiv.tag_value_hash = x'F7CA6A21D278EB5CE64611AADBDB77EF1511D3DD'
  AND b.id IS NULL
LIMIT 10000
ON CONFLICT DO NOTHING
