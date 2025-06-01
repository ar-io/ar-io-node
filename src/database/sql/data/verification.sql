-- selectVerifiableContiguousDataIds
SELECT cd.id
FROM contiguous_data_ids cd
JOIN bundles.bundle_data_items bdi ON bdi.id = cd.id
WHERE cd.verified = FALSE
  AND bdi.root_transaction_id IS NOT NULL
  AND COALESCE(cd.verification_priority, 0) >= @min_verification_priority
ORDER BY cd.verification_priority DESC NULLS LAST, cd.verification_retry_count ASC NULLS FIRST, cd.id ASC
LIMIT 1000;

-- updateDataItemVerificationStatus
UPDATE contiguous_data_ids
SET
  verified = 1,
  verified_at = @verified_at
WHERE id = @id OR id IN (
  SELECT id FROM bundles.bundle_data_items WHERE root_transaction_id = @id
);

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
  verification_priority = @priority
WHERE id = @id;
