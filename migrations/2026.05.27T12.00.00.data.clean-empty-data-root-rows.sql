-- up migration

-- Clean rogue empty/NULL data_root rows that the previously-unguarded
-- insertDataRoot may have left behind. Such rows poisoned
-- getDataAttributes for any L1 tx with an empty data_root: the fallback
-- branch of selectDataAttributes matched the empty value and returned an
-- unrelated file's hash, serving wrong content with a misleading
-- X-AR-IO-Digest. The read/write guards in
-- src/database/sql/data/content-attributes.sql prevent new poison rows;
-- this removes any already planted. Idempotent and forward-only.

DELETE FROM data_roots
WHERE data_root IS NULL OR length(data_root) = 0;
