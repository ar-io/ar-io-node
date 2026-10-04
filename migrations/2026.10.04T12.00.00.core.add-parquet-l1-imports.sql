-- Bands imported from a `parquet-l1` index, one row per band, written in the
-- same transaction as the band's rows. A re-run skips what this table holds,
-- so an import is resumable and never applies a band twice.
CREATE TABLE IF NOT EXISTS parquet_l1_imports (
  band_id TEXT PRIMARY KEY,
  height_from INTEGER NOT NULL,
  height_to INTEGER NOT NULL,
  -- Digest of the band's per-table row digests: the same band rebuilt with
  -- different rows is a different import.
  band_digest BLOB NOT NULL,
  rows_imported INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS parquet_l1_imports_height_from_idx
  ON parquet_l1_imports (height_from);
