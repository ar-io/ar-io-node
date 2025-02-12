DROP INDEX IF EXISTS import_attempt_last_retried_idx;

CREATE INDEX import_attempt_last_retried_idx ON bundles (import_attempt_count, last_retried_at)
WHERE last_fully_indexed_at IS NULL;
