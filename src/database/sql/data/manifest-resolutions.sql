-- selectManifestResolution
SELECT index_id, fallback_id
FROM manifest_resolutions
WHERE manifest_id = @manifest_id;

-- upsertManifestResolution
INSERT INTO manifest_resolutions (
  manifest_id,
  index_id,
  fallback_id,
  resolved_at
) VALUES (
  @manifest_id,
  @index_id,
  @fallback_id,
  @resolved_at
)
ON CONFLICT(manifest_id) DO UPDATE SET
  index_id = COALESCE(@index_id, index_id),
  fallback_id = COALESCE(@fallback_id, fallback_id),
  resolved_at = @resolved_at;
