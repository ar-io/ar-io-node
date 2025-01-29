ALTER TABLE bundles ADD COLUMN retry_attempt_count INTEGER;
ALTER TABLE bundles ADD COLUMN first_retried_at INTEGER;
ALTER TABLE bundles ADD COLUMN last_retried_at INTEGER;

DROP INDEX IF EXISTS import_attempt_last_queued_idx;
CREATE INDEX IF NOT EXISTS import_attempt_last_retried_idx ON bundles (import_attempt_count, last_retried_at);
CREATE INDEX IF NOT EXISTS root_transaction_id_idx ON bundles (root_transaction_id);
