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

-- Ensure x402Tokens exists (for backward compatibility)
bucket.x402Tokens = bucket.x402Tokens or 0
bucket.tokens = bucket.tokens or 0

-- Consume tokens: prioritize x402 tokens first, then regular tokens
local x402Consumed = 0
local regularConsumed = 0

if cost > 0 then
  -- Positive cost: consume tokens
  if bucket.x402Tokens >= cost then
    -- Sufficient x402 tokens
    bucket.x402Tokens = bucket.x402Tokens - cost
    x402Consumed = cost
  elseif bucket.x402Tokens > 0 then
    -- Partial x402, remainder from regular
    x402Consumed = bucket.x402Tokens
    local remainder = cost - x402Consumed
    bucket.x402Tokens = 0
    bucket.tokens = bucket.tokens - remainder
    regularConsumed = remainder
  else
    -- No x402 tokens, use regular only
    bucket.tokens = bucket.tokens - cost
    regularConsumed = cost
  end
elseif cost < 0 then
  -- Negative cost: refund tokens (return to regular pool)
  bucket.tokens = bucket.tokens - cost  -- subtract negative = add
end

-- Update bucket in Redis
redis.call('HSET', key, 'tokens', bucket.tokens)
redis.call('HSET', key, 'x402Tokens', bucket.x402Tokens)

-- Store contentLength if provided
if contentLength then
  redis.call('HSET', key, 'contentLength', contentLength)
end

-- Refresh TTL
redis.call('EXPIRE', key, ttl)

-- Return remaining regular tokens (for backward compatibility)
return bucket.tokens
