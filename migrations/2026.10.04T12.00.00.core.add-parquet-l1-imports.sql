-- Bands imported from a `parquet-l1` index, one row per band.
--
-- A row is written before the band's own rows and completed after them, so
-- a crash is visible: a row with no `completed_at` marks a band only partly
-- applied, which an import must redo rather than trust. Progress is read
-- from this table, never from how far `stable_blocks` happens to reach,
-- because a band writes all of its blocks long before its transactions.
CREATE TABLE IF NOT EXISTS parquet_l1_imports (
  band_id TEXT PRIMARY KEY,
  height_from INTEGER NOT NULL,
  height_to INTEGER NOT NULL,
  -- Digest of the band's per-table row digests: the same band rebuilt with
  -- different rows is a different import.
  band_digest BLOB NOT NULL,
  rows_imported INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS parquet_l1_imports_height_from_idx
  ON parquet_l1_imports (height_from);
