-- up migration
--
-- Adds bundles_large_active_priority_idx — a partial index supporting the
-- new `selectLargeFailedBundleIds` SQL statement (parallel retry lane for
-- Turbo-class bundles).
--
-- Partial WHERE predicate keeps the index tiny: it only covers bundles that
-- are (a) not yet fully indexed and (b) known to have data_item_count >= 50
-- (Turbo bulk threshold; direct ArDrive bundles have 1-2 DIs). On a 9.8M-row
-- bundles.db with ~1k known-large bundles in flight, the index is a few MB.
--
-- The 50 literal in the partial WHERE matches the default value of the
-- BUNDLE_REPAIR_LARGE_BUNDLE_THRESHOLD env var. If operators lower that env,
-- the partial index will still serve queries (just for the >= 50 subset);
-- queries with threshold < 50 will fall back to a full scan. Operators who
-- want to lower the threshold permanently should also adjust this index.

CREATE INDEX IF NOT EXISTS bundles_large_active_priority_idx
  ON bundles (data_item_count, retry_attempt_count, last_retried_at)
  WHERE last_fully_indexed_at IS NULL AND data_item_count >= 50;

ANALYZE bundles;
