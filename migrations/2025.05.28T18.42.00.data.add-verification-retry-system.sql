-- Add verification retry system to contiguous_data_ids table

-- Add verification-related columns (SQLite requires separate ALTER TABLE statements)
ALTER TABLE contiguous_data_ids 
ADD COLUMN verification_retry_count INTEGER;

ALTER TABLE contiguous_data_ids 
ADD COLUMN verification_priority INTEGER;

ALTER TABLE contiguous_data_ids 
ADD COLUMN first_verification_attempted_at INTEGER;

ALTER TABLE contiguous_data_ids 
ADD COLUMN last_verification_attempted_at INTEGER;

-- Drop the old verification index as the new one will cover the same use case
DROP INDEX IF EXISTS contiguous_data_ids_verified;

-- Create index to help with ordering by priority first, then retry count
-- This index also covers the use case of the old contiguous_data_ids_verified index
CREATE INDEX contiguous_data_ids_verification_priority_retry_idx 
ON contiguous_data_ids (verification_priority DESC, verification_retry_count ASC, id ASC) 
WHERE verified = FALSE;