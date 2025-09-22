-- KEYS[1] = bucketKey (hash)
-- ARGV[1] = cost (positive integer)
-- ARGV[2] = now (epoch-ms)
-- ARGV[3] = ttl (seconds)
-- ARGV[4] = contentLength (optional, in bytes)

local cost = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local contentLength = ARGV[4] and tonumber(ARGV[4]) or nil

local key = KEYS[1]

-- Decrement tokens atomically
local remaining = redis.call('HINCRBY', key, 'tokens', -cost)

-- Store contentLength if provided
if contentLength then
  redis.call('HSET', key, 'contentLength', contentLength)
end

-- Touch lastRefill + refresh TTL
redis.call('HSET', key, 'lastRefill', now)
redis.call('EXPIRE', key, ttl)

return remaining