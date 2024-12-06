-- insertBlockedId
INSERT INTO blocked_ids (id, block_source_id, notes, blocked_at)
VALUES (@id, @block_source_id, @notes, @blocked_at)
ON CONFLICT DO NOTHING

-- insertBlockedHash
INSERT INTO blocked_hashes (hash, block_source_id, notes, blocked_at)
VALUES (@hash, @block_source_id, @notes, @blocked_at)
ON CONFLICT DO NOTHING

-- insertSource
INSERT INTO block_sources (name, created_at)
VALUES (@name, @created_at)
ON CONFLICT DO NOTHING

-- getSourceByName
SELECT id, name, created_at
FROM block_sources
WHERE name = @name

-- insertBlockedName
INSERT INTO blocked_names (name, block_source_id, notes, blocked_at)
VALUES (@name, @block_source_id, @notes, @blocked_at)
ON CONFLICT DO NOTHING

-- deleteBlockedName
DELETE FROM blocked_names
WHERE name = @name;
