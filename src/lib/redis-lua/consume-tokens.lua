-- KEYS[1] = bucketKey (hash)
-- ARGV[1] = cost (can be positive or negative for adjustment)
-- ARGV[2] = ttl (seconds)
-- ARGV[3] = contentLength (optional, in bytes)

local cost = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local contentLength = ARGV[3] and tonumber(ARGV[3]) or nil

local key = KEYS[1]

-- Get current bucket state
local all = redis.call('HGETALL', key)
if #all == 0 then
  -- Bucket doesn't exist - this shouldn't happen in normal flow
  return 0
end

local bucket = {}
for i = 1, #all, 2 do
  bucket[all[i]] = tonumber(all[i+1]) or all[i+1]
end

-- Ensure paidTokens exists (for backward compatibility)
bucket.paidTokens = bucket.paidTokens or 0
bucket.tokens = bucket.tokens or 0

-- Consume tokens: prioritize paid tokens first, then regular tokens
local paidConsumed = 0
local regularConsumed = 0

if cost > 0 then
  -- Positive cost: consume tokens
  if bucket.paidTokens >= cost then
    -- Sufficient paid tokens
    bucket.paidTokens = bucket.paidTokens - cost
    paidConsumed = cost
  elseif bucket.paidTokens > 0 then
    -- Partial paid, remainder from regular
    paidConsumed = bucket.paidTokens
    local remainder = cost - paidConsumed
    bucket.paidTokens = 0
    bucket.tokens = bucket.tokens - remainder
    regularConsumed = remainder
  else
    -- No paid tokens, use regular only
    bucket.tokens = bucket.tokens - cost
    regularConsumed = cost
  end
elseif cost < 0 then
  -- Negative cost: refund tokens (return to regular pool)
  bucket.tokens = bucket.tokens - cost  -- subtract negative = add
end

-- Update bucket in Redis
redis.call('HSET', key, 'tokens', bucket.tokens)
redis.call('HSET', key, 'paidTokens', bucket.paidTokens)

-- Store contentLength if provided
if contentLength then
  redis.call('HSET', key, 'contentLength', contentLength)
end

-- Refresh TTL
redis.call('EXPIRE', key, ttl)

-- Return structured result matching getOrCreateBucketAndConsume
local result = {
  bucket = bucket,
  consumed = paidConsumed + regularConsumed,
  paidConsumed = paidConsumed,
  regularConsumed = regularConsumed
}

return cjson.encode(result)
