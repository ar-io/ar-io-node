-- Down migration: drop indexes before the table they cover.
DROP INDEX IF EXISTS chunk_placements_gc_idx;
DROP INDEX IF EXISTS chunk_placements_hash_idx;
DROP TABLE IF EXISTS chunk_placements;
