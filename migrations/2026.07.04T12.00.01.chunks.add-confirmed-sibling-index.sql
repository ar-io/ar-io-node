-- Partial index supporting the sibling-confirmation fallback in
-- saveChunkPlacement (cache.sql).
--
-- When the confirmed_data_roots marker is absent (COALESCE short-circuits past
-- it), the insert falls back to
--   SELECT sibling.confirmed_at FROM chunk_placements
--   WHERE data_root = @data_root AND confirmed_at IS NOT NULL LIMIT 1
-- Without an index this scans the whole data_root range on the (data_root,
-- relative_offset) primary key, which for a bundle that ingests many chunks
-- before its TX_INDEXED confirm event makes each insert O(n) and the pre-confirm
-- window O(n²) (a multi-GB, thousands-of-chunk bundle is the worst case).
--
-- This PARTIAL index contains only confirmed rows, so it is tiny (empty during
-- the pre-confirmation window, exactly when the fallback runs most) and lets the
-- lookup seek by data_root in O(log n). A separate migration (not folded into the
-- confirmed_data_roots table migration) so it also applies on gateways where that
-- earlier migration was already recorded.
CREATE INDEX IF NOT EXISTS chunk_placements_confirmed_sibling_idx
  ON chunk_placements (data_root)
  WHERE confirmed_at IS NOT NULL;
