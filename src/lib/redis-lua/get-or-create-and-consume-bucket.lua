--[[
Token Bucket Rate Limiter - Atomic Get/Create and Consume Operation

This Lua script implements a token bucket algorithm that atomically:
1. Gets or creates a bucket with token refill logic
2. Attempts to consume tokens for a request
3. Doubles refill rate and increases capacity if x402 payment is provided
3. Returns the bucket state and consumption result

The atomic nature prevents race conditions between checking token availability
and consuming them, which is critical for accurate rate limiting.
]]

-- Input parameters
-- KEYS[1] = bucketKey (unique identifier for this rate limit bucket)
-- ARGV[1] = capacity (maximum tokens the bucket can hold)
-- ARGV[2] = refillRate (tokens added per second)
-- ARGV[3] = now (current timestamp in milliseconds)
-- ARGV[4] = ttl (bucket expiration time in seconds)
-- ARGV[5] = tokensToConsume (predicted tokens needed, defaults to 0)
-- ARGV[6] = x402PaymentProvided (1 if x402 payment was provided, else 0)
-- ARGV[7] = capacityMultiplier (multiplier for bucket capacity when payment provided)
-- ARGV[8] = refillMultiplier (multiplier for refill rate when payment provided, currently unused)
-- ARGV[9] = contentLengthForTopOff (content size in bytes for proportional top-off calculation)

-- Parse input arguments with proper type conversion
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local tokensToConsume = tonumber(ARGV[5]) or 0
local x402PaymentProvided = ARGV[6] == "1"
local capacityMultiplier = tonumber(ARGV[7]) or 10
local refillMultiplier = tonumber(ARGV[8]) or 2
local contentLengthForTopOff = tonumber(ARGV[9]) or 0

local key = KEYS[1]

-- Step 1: Get or create the token bucket
-- Try to get existing bucket data - HGETALL returns empty array if key doesn't exist
local all = redis.call('HGETALL', key)
local bucket

if #all > 0 then
  -- Bucket exists - reconstruct it from Redis hash data
  bucket = { key = key }
  -- Convert hash fields back to bucket object
  for i = 1, #all, 2 do bucket[all[i]] = tonumber(all[i+1]) or all[i+1] end

  -- Step 2: Refill tokens based on elapsed time (token bucket algorithm)
  local elapsed = (now - bucket.lastRefill) / 1000  -- convert to seconds

  -- Calculate effective capacity for this operation
  -- IMPORTANT: DO NOT modify bucket.capacity or bucket.refillRate - they must remain at base values
  local effectiveCapacity = bucket.capacity
  local to_add = 0

  -- Apply multipliers and calculate tokens to add based on payment status
  if x402PaymentProvided then
    -- For paid requests: calculate proportional top-off based on content size
    if contentLengthForTopOff > 0 then
      -- Calculate base tokens from content length (1 token = 1 KB)
      local baseTokens = math.max(1, math.ceil(contentLengthForTopOff / 1024))
      -- Apply capacity multiplier to get effective capacity
      effectiveCapacity = baseTokens * capacityMultiplier
    else
      -- Fallback to base capacity multiplier if no content length provided
      effectiveCapacity = effectiveCapacity * capacityMultiplier
    end
    -- Top-off to effective capacity (instant refill for paid requests)
    to_add = effectiveCapacity
  else
    -- For unpaid requests: normal time-based refill at base rate
    to_add = math.floor(elapsed * bucket.refillRate)
  end

  -- Add tokens but cap at effective capacity (prevents overflow)
  if to_add > 0 then
    bucket.tokens = math.min(effectiveCapacity, bucket.tokens + to_add)
    bucket.lastRefill = now  -- update last refill timestamp
  end

else
  -- Step 2: Create new bucket with full capacity at base values
  bucket = {
    key = key,
    tokens = capacity,      -- start with full tokens at base capacity
    lastRefill = now,       -- current time as baseline
    capacity = capacity,    -- base capacity (not multiplied)
    refillRate = refill     -- base refill rate (not multiplied)
  }
  -- if x402PaymentProvided, start with boosted tokens based on content size
  if x402PaymentProvided then
    local effectiveCapacity
    if contentLengthForTopOff > 0 then
      -- Calculate proportional top-off based on content size
      local baseTokens = math.max(1, math.ceil(contentLengthForTopOff / 1024))
      effectiveCapacity = baseTokens * capacityMultiplier
    else
      -- Fallback to base capacity multiplier if no content length provided
      effectiveCapacity = capacity * capacityMultiplier
    end
    bucket.tokens = effectiveCapacity  -- start with full tokens at boosted capacity
  end
end

-- Step 3: Calculate actual tokens needed
-- Start with the prediction, but use cached content length if available for accuracy
local actualTokensNeeded = tokensToConsume  -- default to prediction

if tokensToConsume > 0 and bucket.contentLength and bucket.contentLength > 0 then
  actualTokensNeeded = math.max(1, math.ceil(bucket.contentLength / 1024))
end

-- Step 4: Attempt atomic token consumption
local consumed = 0
local success = true

if actualTokensNeeded > 0 then
  if bucket.tokens >= actualTokensNeeded then
    -- Sufficient tokens available - consume them
    bucket.tokens = bucket.tokens - actualTokensNeeded
    consumed = actualTokensNeeded
    success = true
  else
    -- Insufficient tokens - fail the request (no partial consumption)
    consumed = 0
    success = false
  end
end

-- TODO: Encode these more compactly/intelligently
-- Step 5: Persist bucket state to Redis using hash for efficiency
local hset_args = {
  key,
  'tokens',      bucket.tokens,      -- remaining tokens after consumption
  'lastRefill',  bucket.lastRefill,  -- timestamp of last refill
  'capacity',    bucket.capacity,    -- maximum bucket capacity
  'refillRate',  bucket.refillRate   -- tokens added per second
}

-- Preserve cached content length for future requests (if it exists)
if bucket.contentLength then
  table.insert(hset_args, 'contentLength')
  table.insert(hset_args, bucket.contentLength)
end

-- Save bucket state and set expiration to prevent memory leaks
redis.call('HSET', unpack(hset_args))
redis.call('EXPIRE', key, ttl)

-- Step 6: Return structured result for the application
local result = {
  bucket = bucket,    -- current bucket state
  consumed = consumed, -- tokens actually consumed
  success = success   -- whether the consumption succeeded
}

return cjson.encode(result)
