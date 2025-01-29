ALTER TABLE bundles DROP COLUMN retry_attempt_count;
ALTER TABLE bundles DROP COLUMN first_retried_at;
ALTER TABLE bundles DROP COLUMN last_retried_at;

CREATE INDEX IF NOT EXISTS import_attempt_last_queued_idx ON bundles (import_attempt_count, last_queued_at);
DROP INDEX IF EXISTS import_attempt_last_retried_idx;
DROP INDEX IF EXISTS root_transaction_id_idx;
