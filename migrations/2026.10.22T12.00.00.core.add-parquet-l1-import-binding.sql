-- How each imported range was bound to the chain before it was written, so
-- a range accepted unbound or unanchored never vouches, as the block above,
-- for a band imported beneath it. NULL on rows written before this column:
-- those were never verified, and vouch for nothing.
--
-- binding: 'anchored' (a network anchor at its top), 'held' (the block the
-- gateway held above it), or 'unanchored' (--allow-unanchored).
ALTER TABLE parquet_l1_imports ADD COLUMN binding TEXT;
-- The flags that accepted something for the range, as a JSON array.
ALTER TABLE parquet_l1_imports ADD COLUMN accepted TEXT;
