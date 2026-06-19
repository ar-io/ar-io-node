-- Optimistic chunk ingest cache + chunk-metadata index (#5a).
--
-- Creates a new `chunks.db` database. The migration runner derives the target
-- database from the schema segment of this filename (`...chunks...`) and opens
-- `data/sqlite/chunks.db`, so no runner change is required (see src/migrate.ts
-- extractDbName).
--
-- `chunk_placements` serves two roles at once:
--   1. Ingest ledger — `origin`, `cached_at`, and `confirmed_at` let the GC
--      sweep evict chunks whose `data_root` never confirms on-chain.
--   2. Chunk metadata index (#5a) — keyed by (data_root, relative_offset),
--      replacing the filesystem msgpack metadata tree and the racy
--      by-absolute-offset symlink index. Raw chunk bytes stay on the
--      filesystem (by-dataroot keying); SQLite owns the metadata.
--
-- `relative_offset` is the chunk's end-byte offset within the transaction data
-- (the ANS-104/merkle "offset", NOT the absolute weave offset). Absolute-offset
-- reads resolve through TxBoundarySource to (data_root, relative_offset) and
-- then PK-query this table.

CREATE TABLE IF NOT EXISTS chunk_placements (
  data_root        BLOB    NOT NULL,
  relative_offset  INTEGER NOT NULL,
  data_size        INTEGER NOT NULL,
  chunk_size       INTEGER NOT NULL,
  hash             BLOB    NOT NULL,
  data_path        BLOB    NOT NULL,
  tx_path          BLOB,
  origin           INTEGER NOT NULL,
  cached_at        INTEGER NOT NULL,
  confirmed_at     INTEGER,
  PRIMARY KEY (data_root, relative_offset)
);

-- Dedup / by-hash lookups (supports the #5a hash-keyed byte layout and
-- "show me dedup opportunities" admin queries).
CREATE INDEX IF NOT EXISTS chunk_placements_hash_idx
  ON chunk_placements (hash);

-- GC sweep: WHERE confirmed_at IS NULL AND cached_at < cutoff. confirmed_at
-- leads so the planner seeks the NULL (pending) group, then ranges on cached_at.
CREATE INDEX IF NOT EXISTS chunk_placements_gc_idx
  ON chunk_placements (confirmed_at, cached_at);
