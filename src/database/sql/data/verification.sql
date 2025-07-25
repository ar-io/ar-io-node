-- selectVerifiableContiguousDataIds
SELECT cd.id
FROM contiguous_data_ids cd
WHERE cd.verified = FALSE 
  AND COALESCE(cd.verification_priority, 0) >= @min_verification_priority
  AND COALESCE(cd.verification_retry_count, 0) < @max_verification_retries
ORDER BY cd.verification_priority DESC NULLS LAST, cd.verification_retry_count ASC NULLS FIRST, cd.id ASC
LIMIT 1000;

-- updateDataItemVerificationStatus
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
