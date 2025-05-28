-- selectVerifiableContiguousDataIds
SELECT cd.id
FROM contiguous_data_ids cd
JOIN bundles.bundle_data_items bdi ON bdi.id = cd.id
WHERE cd.verified = FALSE AND bdi.root_transaction_id IS NOT NULL
ORDER BY cd.verification_priority DESC NULLS LAST, cd.verification_retry_count ASC NULLS FIRST, cd.id ASC
LIMIT 1000;
