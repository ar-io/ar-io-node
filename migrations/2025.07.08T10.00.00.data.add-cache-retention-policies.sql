-- addCacheRetentionPolicies
ALTER TABLE contiguous_data ADD COLUMN retention_policy_id TEXT;

-- addCacheRetentionExpiresAt
ALTER TABLE contiguous_data ADD COLUMN retention_expires_at INTEGER;

-- createRetentionExpiresIndex
CREATE INDEX contiguous_data_retention_expires_idx 
ON contiguous_data(retention_expires_at) 
WHERE retention_expires_at IS NOT NULL;