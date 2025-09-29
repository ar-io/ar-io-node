-- KEYS[1] = bucketKey (hash)
-- ARGV[1] = cost (positive integer)
-- ARGV[2] = ttl (seconds)
-- ARGV[3] = contentLength (optional, in bytes)

local cost = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local contentLength = ARGV[3] and tonumber(ARGV[3]) or nil

local key = KEYS[1]

-- Decrement tokens atomically
local remaining = redis.call('HINCRBY', key, 'tokens', -cost)

-- Store contentLength if provided
if contentLength then
  redis.call('HSET', key, 'contentLength', contentLength)
end

-- Refresh TTL
redis.call('EXPIRE', key, ttl)

return remaining
