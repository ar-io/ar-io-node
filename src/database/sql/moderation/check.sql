-- isIdBlocked
SELECT 1 AS is_blocked
FROM blocked_ids
WHERE id = @id

-- isHashBlocked
SELECT 1 AS is_blocked
FROM blocked_hashes
WHERE hash = @hash

-- isNameBlocked
SELECT 1 AS is_blocked
FROM blocked_names
WHERE name = @name

-- selectBlockedNames
SELECT name FROM blocked_names;
