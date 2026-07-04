-- Sticky-confirmation marker table.
--
-- `confirmed_data_roots` records data_roots whose bundle transaction has been
-- indexed (confirmed). Optimistic chunk-placement confirmation is triggered by a
-- one-shot TX_INDEXED UPDATE that only touches chunks present at that instant; a
-- large multi-GB bundle streams its chunks in over a window far longer than that
-- single event, so the late arrivals would otherwise stay unconfirmed and get
-- TTL-evicted (leaving a gappy, unservable set — e.g. relative_offset 0 missing).
--
-- This table lets confirmation "stick" per data_root:
--   * saveChunkPlacement inherits confirmed_at from it, so chunks ingested AFTER
--     the confirm event still confirm at ingest; and
--   * the GC TTL sweep skips any data_root present here, so a confirmed bundle is
--     never partially evicted regardless of per-row confirmed_at.
--
-- It is populated by confirmChunkPlacements ONLY for data_roots we have actually
-- ingested chunks for (gated on EXISTS in chunk_placements), so it stays bounded
-- by ingested bundles rather than growing to the size of the whole tx index.
CREATE TABLE IF NOT EXISTS confirmed_data_roots (
  data_root    BLOB    PRIMARY KEY,
  confirmed_at INTEGER NOT NULL
);
