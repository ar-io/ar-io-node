-- down migration
-- Remove bundle metadata columns from contiguous_data_ids table

-- SQLite doesn't support dropping columns directly, so we need to recreate the table
-- Create a new table without the new columns
CREATE TABLE contiguous_data_ids_new (
  id BLOB PRIMARY KEY,
  contiguous_data_hash BLOB,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  indexed_at INTEGER NOT NULL,
  verified_at INTEGER,
  verification_retry_count INTEGER,
  verification_priority INTEGER,
  first_verification_attempted_at INTEGER,
  last_verification_attempted_at INTEGER
);

-- Copy data from old table to new table
INSERT INTO contiguous_data_ids_new 
  (id, contiguous_data_hash, verified, indexed_at, verified_at, 
   verification_retry_count, verification_priority, 
   first_verification_attempted_at, last_verification_attempted_at)
SELECT 
  id, contiguous_data_hash, verified, indexed_at, verified_at,
  verification_retry_count, verification_priority,
  first_verification_attempted_at, last_verification_attempted_at
FROM contiguous_data_ids;

-- Drop the old table
DROP TABLE contiguous_data_ids;

-- Rename the new table to the original name
ALTER TABLE contiguous_data_ids_new RENAME TO contiguous_data_ids;

-- Recreate the existing indexes
CREATE INDEX contiguous_data_ids_contiguous_data_hash_idx ON contiguous_data_ids (contiguous_data_hash);
CREATE INDEX contiguous_data_ids_verification_priority_retry_idx 
ON contiguous_data_ids (verification_priority DESC, verification_retry_count ASC, id ASC) 
WHERE verified = FALSE;