-- Remove verification retry system from contiguous_data_ids table

-- Drop the verification priority/retry index
DROP INDEX IF EXISTS contiguous_data_ids_verification_priority_retry_idx;

-- Recreate the original verification index
CREATE INDEX contiguous_data_ids_verified ON contiguous_data_ids (id) WHERE verified = FALSE;

-- Drop all verification-related columns (SQLite requires separate ALTER TABLE statements)
ALTER TABLE contiguous_data_ids 
DROP COLUMN verification_retry_count;

ALTER TABLE contiguous_data_ids 
DROP COLUMN verification_priority;

ALTER TABLE contiguous_data_ids 
DROP COLUMN first_verification_attempted_at;

ALTER TABLE contiguous_data_ids 
DROP COLUMN last_verification_attempted_at;