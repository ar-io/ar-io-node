-- Persistent index of resolved manifest index/fallback ids, keyed by manifest
-- transaction id. Populated lazily on request by StreamingManifestPathResolver
-- and read by resolveFromIndex to serve a manifest root/index without
-- re-fetching or re-parsing the manifest body. Values are immutable per
-- manifest transaction, so no invalidation is required.
CREATE TABLE IF NOT EXISTS manifest_resolutions (
  manifest_id BLOB PRIMARY KEY,
  index_id BLOB,
  fallback_id BLOB,
  resolved_at INTEGER NOT NULL
);
