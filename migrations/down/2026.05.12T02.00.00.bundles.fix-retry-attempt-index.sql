-- down migration
--
-- Restore `import_attempt_last_retried_idx` as defined by
-- 2025.02.12T21.11.24.bundles.filtered_import_attempt_idx.sql and drop the
-- new composite. Note: the down migration reinstates the prior (broken)
-- index for rollback purposes only; the retry-loop query will revert to
-- using a temp B-tree for the ORDER BY.

DROP INDEX IF EXISTS bundles_active_retry_priority_idx;

CREATE INDEX IF NOT EXISTS import_attempt_last_retried_idx
  ON bundles (import_attempt_count, last_retried_at)
  WHERE last_fully_indexed_at IS NULL;
