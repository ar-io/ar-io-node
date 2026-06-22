-- up migration
--
-- Replace `import_attempt_last_retried_idx` with an index that supports the
-- actual `selectFailedBundleIds` query in `src/database/sql/bundles/repair.sql`.
--
-- Root cause: the Jan 2025 retry-stats refactor (commit 528e1840,
-- migration 2025.01.30T14.12.03.bundles.add-retry-stats.sql) changed
-- the query's `ORDER BY` from `import_attempt_count, last_queued_at` to
-- `retry_attempt_count, last_retried_at` and updated the trailing column
-- of the index from `last_queued_at` to `last_retried_at`, but left the
-- leading column as `import_attempt_count` instead of swapping it to
-- `retry_attempt_count`. The Feb 2025 follow-up (2025.02.12T21.11.24)
-- only added the partial-index predicate; it perpetuated the mismatch.
--
-- Result: for ~15 months the planner has been falling back to
-- `bundles_last_fully_indexed_at_idx` + a temp B-tree on millions of rows
-- to satisfy the `ORDER BY`, costing ~9 s per retry-loop pick.
--
-- The new index is non-partial. A partial form
-- `(retry_attempt_count, last_retried_at) WHERE last_fully_indexed_at IS NULL`
-- is smaller but the SQLite planner ignores it for this query — it prefers
-- MULTI-INDEX OR + temp sort over scanning a partial index when the WHERE
-- contains an OR. The non-partial composite with `last_fully_indexed_at` as
-- the leading column lets the planner do an equality search on `IS NULL` and
-- walk the rest of the entries in index order, eliminating the temp sort.
--
-- `import_attempt_count` is exposed via `/ar-io/admin/bundle-status/:id`
-- (OpenAPI) but that lookup is served by the primary-key index, so dropping
-- the old index is safe.
--
-- Measured (on a ~10M-row bundles.db cp): 1,735 ms → 5 ms offline.
-- Live (under concurrent writes): 4.32 s → 20.5 ms (~211x).

DROP INDEX IF EXISTS import_attempt_last_retried_idx;

CREATE INDEX IF NOT EXISTS bundles_active_retry_priority_idx
  ON bundles (last_fully_indexed_at, retry_attempt_count, last_retried_at);

ANALYZE bundles;
