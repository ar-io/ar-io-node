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
  -- Bucket doesn't exist - return structured failure for consistency
  local emptyBucket = {
    key = key,
    tokens = 0,
    paidTokens = 0,
    lastRefill = 0,
    capacity = 0,
    refillRate = 0
  }
  local result = {
    bucket = emptyBucket,
    consumed = 0,
    paidConsumed = 0,
    regularConsumed = 0,
    success = false
  }
  return cjson.encode(result)
end

local bucket = {}
for i = 1, #all, 2 do
  bucket[all[i]] = tonumber(all[i+1]) or all[i+1]
end

-- Ensure paidTokens exists (for backward compatibility)
bucket.paidTokens = bucket.paidTokens or 0
bucket.tokens = bucket.tokens or 0

-- Consume tokens: prioritize regular tokens first, then paid tokens
-- INVARIANT: paidTokens must never go negative
-- Regular tokens can go negative (over-consumption), but paid tokens cannot
local paidConsumed = 0
local regularConsumed = 0
local success = true

if cost > 0 then
  -- Positive cost: consume tokens
  if bucket.tokens >= cost then
    -- Sufficient regular tokens
    bucket.tokens = bucket.tokens - cost
    regularConsumed = cost
  elseif bucket.tokens > 0 then
    -- Partial regular, remainder from paid
    regularConsumed = bucket.tokens
    local remainder = cost - regularConsumed

    -- Validate sufficient paid tokens before consuming
    if bucket.paidTokens >= remainder then
      -- Sufficient paid tokens for remainder
      bucket.tokens = 0
      bucket.paidTokens = bucket.paidTokens - remainder
      paidConsumed = remainder
    else
      -- Insufficient paid tokens - consume what's available (partial consumption)
      bucket.tokens = 0
      paidConsumed = bucket.paidTokens
      bucket.paidTokens = 0
      success = false
    end
  else
    -- No regular tokens, validate and use paid only
    if bucket.paidTokens >= cost then
      -- Sufficient paid tokens
      bucket.paidTokens = bucket.paidTokens - cost
      paidConsumed = cost
    else
      -- Insufficient paid tokens - consume all available (partial consumption)
      paidConsumed = bucket.paidTokens
      bucket.paidTokens = 0
      success = false
    end
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
  regularConsumed = regularConsumed,
  success = success
}

return cjson.encode(result)
