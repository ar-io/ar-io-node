--[[
Add Paid Tokens - Atomic operation to add paid tokens to a rate limiter bucket

This Lua script atomically:
1. Gets or creates a token bucket
2. Refills regular tokens based on elapsed time
3. Adds paid tokens directly (no conversion needed)
4. Returns the updated bucket state

This is used for payment-based token top-offs where the token amount
has already been calculated from the payment amount.
]]

-- Input parameters
-- KEYS[1] = bucketKey (unique identifier for this rate limit bucket)
-- ARGV[1] = capacity (base maximum tokens the bucket can hold)
-- ARGV[2] = refillRate (tokens added per second for regular tokens)
-- ARGV[3] = now (current timestamp in milliseconds)
-- ARGV[4] = ttl (bucket expiration time in seconds)
-- ARGV[5] = paidTokensToAdd (tokens to add to paid pool - already includes multiplier)

-- Parse input arguments with proper type conversion
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local paidTokensToAdd = tonumber(ARGV[5])

-- Step 1: Get or create the token bucket
local all = redis.call('HGETALL', key)
local bucket

if #all > 0 then
  -- Bucket exists - reconstruct it from Redis hash data
  bucket = { key = key }
  -- Convert hash fields back to bucket object
  for i = 1, #all, 2 do bucket[all[i]] = tonumber(all[i+1]) or all[i+1] end

  -- Ensure paidTokens exists (for backward compatibility with old buckets)
  bucket.paidTokens = bucket.paidTokens or 0

  -- Step 2: Refill regular tokens based on elapsed time (token bucket algorithm)
  local elapsed = (now - bucket.lastRefill) / 1000  -- convert to seconds
  local tokensToAdd = math.floor(elapsed * bucket.refillRate)

  if tokensToAdd > 0 then
    -- Add tokens but cap at base capacity (prevents overflow)
    bucket.tokens = math.min(bucket.capacity, bucket.tokens + tokensToAdd)
    bucket.lastRefill = now  -- update last refill timestamp
  end

  -- Update capacity and refill rate in case config changed
  bucket.capacity = capacity
  bucket.refillRate = refillRate
else
  -- Step 2: Create new bucket with full regular tokens at base capacity
  bucket = {
    key = key,
    tokens = capacity,      -- start with full tokens at base capacity
    paidTokens = 0,         -- no paid tokens initially
    lastRefill = now,       -- current time as baseline
    capacity = capacity,    -- base capacity
    refillRate = refillRate -- base refill rate
  }
end

-- Step 3: Add paid tokens to the bucket
bucket.paidTokens = bucket.paidTokens + paidTokensToAdd

-- Step 4: Persist bucket state to Redis using hash for efficiency
local hset_args = {
  key,
  'tokens',      bucket.tokens,      -- regular tokens after refill
  'paidTokens',  bucket.paidTokens,  -- paid tokens after addition
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

-- Step 5: Return structured result for the application
local result = {
  bucket = bucket,              -- current bucket state
  paidTokensAdded = paidTokensToAdd  -- tokens added to paid pool
}

return cjson.encode(result)
