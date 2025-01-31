-- selectVerifiableContiguousDataIds
SELECT cd.id
FROM contiguous_data_ids cd
JOIN bundles.bundle_data_items bdi ON bdi.id = cd.id
WHERE cd.verified = FALSE AND bdi.root_transaction_id IS NOT NULL
LIMIT 1000;

-- updateDataItemVerificationStatus
UPDATE contiguous_data_ids
SET
  verified = 1,
  verified_at = @verified_at
WHERE id = @id OR id IN (
  SELECT id FROM bundles.bundle_data_items WHERE root_transaction_id = @id
);
