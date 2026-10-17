-- Record each item's own Content-Type alongside its cached data.
--
-- For an item this gateway has not indexed, the content type came only from
-- `contiguous_data.original_source_content_type`, which is keyed by the data
-- hash and so shared by every byte-identical upload. Two items with the same
-- bytes and different `Content-Type` tags (a `text/html` page and a path
-- manifest with the same body) were both served as whichever type was written
-- first, and a manifest relabelled as HTML never resolved.
--
-- Per ID, not per hash, as `content_encoding` is. `content_type_source` says
-- how far the value can be trusted:
--   item     -- the item's own signed `Content-Type` tag (read from its header)
--               or the uploader's per-item record of it (Turbo payload type).
--               Final once written.
--   upstream -- a trusted gateway's answer for this ID. Written only when no
--               value is recorded, and replaced by an `item` value.
-- The per-hash value stays as the last fallback.
ALTER TABLE contiguous_data_ids ADD COLUMN content_type TEXT;
ALTER TABLE contiguous_data_ids ADD COLUMN content_type_source TEXT;
