-- Bands imported from a `parquet-l2` index (`index-l2-import`), one row per
-- band and target.
--
-- The ClickHouse target writes a job for `clickhouse-auto-import` to load:
-- `job` names it and `queued_at` is when it was written. `completed_at` is
-- set once the job is loaded, so a row with `queued_at` and no
-- `completed_at` is a job not yet in ClickHouse, which no run writes again.
-- `height_to` is the top height written so far: a band above the gateway's
-- ClickHouse is imported up to there, and the rest by a later run.
CREATE TABLE IF NOT EXISTS parquet_l2_imports (
  band_id TEXT NOT NULL,
  -- 'clickhouse' or 'sqlite'.
  target TEXT NOT NULL,
  -- The index the band belongs to, e.g. 'ardrive-l2'.
  index_name TEXT NOT NULL,
  -- The wallet the band's publication is signed by.
  publisher TEXT NOT NULL,
  height_from INTEGER NOT NULL,
  height_to INTEGER NOT NULL,
  -- Digest of the band's heights, selection and row digests: the same band
  -- rebuilt with different rows is a different import.
  band_digest BLOB NOT NULL,
  job TEXT,
  -- Rows written, and the band's rows left out: already held by the target
  -- at the same key (`present`) or at another height (`elsewhere`), held
  -- with a different location or owner (`conflicting`, a subset of
  -- `present`), or unlocated where the target needs a location.
  rows_imported INTEGER,
  rows_present INTEGER,
  rows_elsewhere INTEGER,
  rows_conflicting INTEGER,
  rows_unlocated INTEGER,
  -- JSON array of the allow flags the band was accepted with.
  accepted TEXT,
  started_at INTEGER NOT NULL,
  queued_at INTEGER,
  completed_at INTEGER,
  PRIMARY KEY (band_id, target)
);
