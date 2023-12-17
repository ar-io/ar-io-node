-- insertBlockedId
INSERT INTO blocked_ids (id, block_source_id, notes, blocked_at)
VALUES (@id, @block_source_id, @notes, @blocked_at)
ON CONFLICT DO NOTHING

-- insertBlockedHash
INSERT INTO blocked_hashes (hash, block_source_id, notes, blocked_at)
VALUES (@hash, @block_source_id, @notes, @blocked_at)
ON CONFLICT DO NOTHING

-- insertSource
INSERT INTO block_sources (name, indexed_at)
VALUES (@name, @indexed_at)
ON CONFLICT DO NOTHING

-- getSourceByName
SELECT id, name, indexed_at
FROM block_sources
WHERE name = @name
