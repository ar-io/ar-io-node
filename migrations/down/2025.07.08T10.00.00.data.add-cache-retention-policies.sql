-- dropRetentionExpiresIndex
DROP INDEX IF EXISTS contiguous_data_retention_expires_idx;

-- dropCacheRetentionExpiresAt
ALTER TABLE contiguous_data DROP COLUMN retention_expires_at;

-- dropCacheRetentionPolicies
ALTER TABLE contiguous_data DROP COLUMN retention_policy_id;