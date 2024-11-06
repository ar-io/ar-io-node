-- selectUnverifiedContiguousDataIds
SELECT id
FROM contiguous_data_ids
WHERE verified = FALSE;
