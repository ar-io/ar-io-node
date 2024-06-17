-- up migration
CREATE INDEX IF NOT EXISTS import_attempt_last_queued_idx ON bundles (import_attempt_count, last_queued_at);

