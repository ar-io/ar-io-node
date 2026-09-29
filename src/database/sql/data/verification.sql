-- selectVerifiableContiguousDataIds
-- Used when the minimum priority is positive, so an unprioritized (NULL) row
-- can never qualify. The bare range comparison lets SQLite seek straight to
-- the eligible rows in contiguous_data_ids_verification_priority_retry_idx.
-- Wrapping the column in COALESCE would force it to walk every unverified row
-- whenever fewer than LIMIT rows qualify, which is the normal case.
SELECT cd.id
FROM contiguous_data_ids cd
WHERE cd.verified = FALSE
  AND cd.verification_priority >= @min_verification_priority
  AND COALESCE(cd.verification_retry_count, 0) < @max_verification_retries
ORDER BY cd.verification_priority DESC NULLS LAST, cd.verification_retry_count ASC NULLS FIRST, cd.id ASC
LIMIT 1000;

-- selectVerifiableContiguousDataIdsIncludingUnprioritized
-- Used when the minimum priority is zero or below: an unprioritized row counts
-- as priority 0, so every unverified row qualifies (the behavior before
-- priorities existed). That makes LIMIT fill quickly, so the in-order index
-- walk stays cheap.
SELECT cd.id
FROM contiguous_data_ids cd
WHERE cd.verified = FALSE
  AND COALESCE(cd.verification_priority, 0) >= @min_verification_priority
  AND COALESCE(cd.verification_retry_count, 0) < @max_verification_retries
ORDER BY cd.verification_priority DESC NULLS LAST, cd.verification_retry_count ASC NULLS FIRST, cd.id ASC
LIMIT 1000;

-- updateDataItemVerificationStatus
-- Marks a verified root transaction and every data item under it. Each side
-- of the OR is an index probe: id is the primary key, and root_transaction_id
-- has contiguous_data_ids_root_transaction_id_idx. Without that index this
-- statement scans the whole table.
UPDATE contiguous_data_ids
SET
  verified = 1,
  verified_at = @verified_at
WHERE id = @id OR root_transaction_id = @id;

-- incrementVerificationRetryCount
UPDATE contiguous_data_ids
SET
  verification_retry_count = COALESCE(verification_retry_count, 0) + 1,
  first_verification_attempted_at = CASE
    WHEN first_verification_attempted_at IS NULL THEN @current_timestamp
    ELSE first_verification_attempted_at
  END,
  last_verification_attempted_at = @current_timestamp
WHERE id = @id;

-- updateVerificationPriority
UPDATE contiguous_data_ids
SET
  verification_priority = IFNULL(@priority, verification_priority)
WHERE id = @id;
