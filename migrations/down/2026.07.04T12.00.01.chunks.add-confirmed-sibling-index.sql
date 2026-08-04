-- Down migration: drop the sibling-confirmation partial index.
DROP INDEX IF EXISTS chunk_placements_confirmed_sibling_idx;
