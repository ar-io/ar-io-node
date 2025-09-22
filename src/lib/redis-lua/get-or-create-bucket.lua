-- KEYS[1] = bucketKey
-- ARGV[1] = capacity
-- ARGV[2] = refillRate
-- ARGV[3] = now (ms)
-- ARGV[4] = ttl seconds

local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])

local key = KEYS[1]
local ttype = redis.call('TYPE', key).ok
local bucket

if ttype == 'hash' then
  local all = redis.call('HGETALL', key)
  bucket = { key = key }
  for i = 1, #all, 2 do bucket[all[i]] = tonumber(all[i+1]) or all[i+1] end
  local elapsed = (now - bucket.lastRefill) / 1000
  local to_add = math.floor(elapsed * bucket.refillRate)
  if to_add > 0 then
    bucket.tokens = math.min(bucket.capacity, bucket.tokens + to_add)
    bucket.lastRefill = now
  end
  -- Preserve contentLength if it exists
  if bucket.contentLength then
    bucket.contentLength = tonumber(bucket.contentLength)
  end
elseif ttype == 'string' then
  bucket = cjson.decode(redis.call('GET', key))
else
  bucket = {
    key = key, tokens = capacity, lastRefill = now,
    capacity = capacity, refillRate = refill
  }
end

-- persist as hash
local hset_args = {
  key,
  'tokens',      bucket.tokens,
  'lastRefill',  bucket.lastRefill,
  'capacity',    bucket.capacity,
  'refillRate',  bucket.refillRate
}

-- Add contentLength if it exists
if bucket.contentLength then
  table.insert(hset_args, 'contentLength')
  table.insert(hset_args, bucket.contentLength)
end

redis.call('HSET', unpack(hset_args))
redis.call('EXPIRE', key, ttl)

return cjson.encode(bucket)