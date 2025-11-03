# x402 Payment Protocol and Rate Limiting

This guide covers the AR.IO Gateway's x402 payment protocol integration and rate
limiting capabilities, including how to configure and use these features for
traffic management and content monetization.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Rate Limiter Deep Dive](#rate-limiter-deep-dive)
- [x402 Payment Protocol Deep Dive](#x402-payment-protocol-deep-dive)
- [Integration Topics](#integration-topics)
- [Reference](#reference)
- [Troubleshooting](#troubleshooting)
- [Examples](#examples)

## Overview

### What is the Rate Limiter?

The AR.IO Gateway includes a flexible rate limiting system that uses a **token
bucket algorithm** to control traffic. It provides:

- **Two-tier limiting**: Per-resource limits (for individual content) and per-IP
  limits (for clients)
- **Dual token system**: Regular tokens (refilling over time) and paid tokens
  (acquired through payments)
- **Multiple implementations**: In-memory (single-node) or Redis-based
  (distributed)
- **Allowlists**: Exempt specific IPs/CIDRs or ArNS names from rate limiting

The rate limiter tracks data egress in "tokens" where **1 token = 1 KiB (1,024
bytes)**. Buckets refill automatically over time and can be topped off with
payments.

### What is x402?

**x402** is an open-source payment protocol built by Coinbase that leverages the
HTTP 402 "Payment Required" status code to enable frictionless cryptocurrency
payments for web APIs. The protocol is chain-agnostic and token-agnostic,
allowing developers to accept payments without traditional friction points like
account creation, email verification, or OAuth flows.

Key features of the x402 protocol:

- **Zero protocol fees**: No intermediaries or payment processing costs
- **Fast settlement**: Payments settle in approximately 2 seconds
- **Minimal integration**: Simple HTTP status codes and headers
- **Privacy-focused**: No account creation or personal information required

**AR.IO Gateway Implementation:**

The AR.IO Gateway integrates x402 using USDC (USD Coin) on the Base blockchain
network to:

- Monetize data egress with per-byte pricing
- Provide premium rate limit tiers for paying users
- Support both browser-based payments (with visual paywall) and programmatic API
  payments
- Verify and settle payments using x402 facilitators

**Important**: x402 **requires the rate limiter to be enabled**. Payment
requests (402 responses) are only sent when rate limits are exceeded. The x402
protocol is not a standalone feature - it works as an extension of the rate
limiting system to allow users to purchase additional capacity.

#### Rate Limited Endpoints

The rate limiter and x402 payment system apply to data egress endpoints:

- **Transaction/Data Item requests**: `/:txid` and `/:txid/path`
- **Raw data requests**: `/raw/:txid`
- **ArNS resolved content**: All requests resolved through ArNS names
- **Farcaster frames**: `/local/farcaster/frame/:txid`
- **Chunk requests**: `GET /chunk/:offset` (uses fixed size pricing - see note
  below)

#### Not Rate Limited

Currently, the following endpoints are not rate limited:

- GraphQL queries (`/graphql`)
- Chunk POST requests (`POST /chunk`)
- Administrative endpoints (`/ar-io/*`)

**Note on Chunk Pricing:** Chunk requests support two payment models:

1. **Fixed-price payment (new)**: When `CHUNK_PAYMENT_FIXED_PRICE_USDC` is set
   (default 0.001 USDC), chunk GET/HEAD requests can pay a fixed price per
   request to **bypass rate limiting entirely**. This provides unlimited chunk
   access with predictable per-request costs.

2. **Size-based free tier**: Unpaid chunk requests use the rate limiter with a
   fixed size assumption (~360 KiB per request by default, configurable via
   `CHUNK_GET_BASE64_SIZE_BYTES`) for token bucket calculations.

The fixed-price model is simpler and more predictable for high-frequency chunk
access patterns, while the free tier continues to use token bucket rate
limiting.

### How They Work Together

To use x402 payments, you must enable both features (`ENABLE_RATE_LIMITER=true`
and `ENABLE_X_402_USDC_DATA_EGRESS=true`). The gateway supports two payment
models:

#### Token Bucket Model (Data Endpoints)

For data/transaction endpoints (`/:txid`, `/raw/:txid`, etc.):

1. **Free tier**: Users consume regular tokens from their rate limit buckets
2. **Rate limit exceeded**: When limits are exceeded, gateway sends 402 Payment
   Required response (instead of 429)
3. **Payment option**: Users can make a USDC payment to continue access
4. **Paid tier**: Payments add paid tokens to the user's bucket with a
   configurable multiplier (default 10x)
5. **Priority consumption**: Regular tokens are consumed first, then paid tokens
   (paid tokens act as overflow capacity)
6. **Resource bypass**: Paid requests bypass per-resource limits (only IP limits
   apply)

#### Fixed-Price Model (Chunk Endpoints)

For chunk GET/HEAD requests (`/chunk/:offset`):

1. **Fixed-price bypass**: If `CHUNK_PAYMENT_FIXED_PRICE_USDC` > 0 and payment
   header present, requests bypass rate limiting entirely with fixed cost per
   request
2. **No token accounting**: Paid chunk requests don't consume or add tokens to
   buckets
3. **Free tier fallback**: Unpaid chunk requests use normal rate limiting with
   fixed size assumption
4. **Predictable costs**: Every paid chunk request costs exactly
   `CHUNK_PAYMENT_FIXED_PRICE_USDC` regardless of actual chunk size

```
┌─────────────────────────────────────────────────────────────┐
│                      Request Flow                           │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
   ┌──────────┐
   │  Request │
   └──────────┘
         │
         ▼
   ┌──────────────────┐      No      ┌────────────────┐
   │ x402 Payment     ├─────────────▶│ Check Regular  │
   │ Header Present?  │              │ Rate Limits    │
   └────────┬─────────┘              └────────┬───────┘
            │ Yes                             │
            ▼                                 │
   ┌──────────────────┐                       │
   │ Verify Payment   │                       │
   └────────┬─────────┘                       │
            │                                 │
            ▼                                 │
   ┌──────────────────┐                       │
   │ Settle Payment   │                       │
   └────────┬─────────┘                       │
            │                                 │
            ▼                                 │
   ┌──────────────────┐                       │
   │ Top Off Bucket   │                       │
   │ with Paid Tokens │                       │
   │ (10x multiplier) │                       │
   └────────┬─────────┘                       │
            │                                 │
            ▼                                 ▼
   ┌──────────────────────────────────────────────┐
   │  Check Rate Limits (prioritize paid tokens)  │
   └────────────────┬─────────────────────────────┘
                    │
         ┌──────────┴──────────┐
         │                     │
         ▼                     ▼
    ┌─────────┐         ┌──────────┐
    │ Allowed │         │ Denied   │
    └────┬────┘         │ Return   │
         │              │ 402 or   │
         ▼              │ 429      │
    ┌─────────┐         └──────────┘
    │ Serve   │
    │ Content │
    └─────────┘
```

### Network Options

The x402 integration supports two Base blockchain networks: **Base Sepolia**
(testnet with free USDC for development) and **Base** (mainnet with real USDC
for production). For detailed comparison of features, faucets, and
configuration, see [Network Comparison](#network-comparison) in the Reference
section.

### Use Cases

**Rate Limiter Only (No Payments):**

- Protect gateway resources from abuse
- Ensure fair access across users
- Manage operational costs
- Simple configuration without payment infrastructure

**Rate Limiter + x402 Payments (Recommended for Production):**

- Monetize data egress to cover infrastructure costs
- Free tier for casual users (rate limited)
- Premium tier for power users (pay to bypass limits)
- Flexible traffic management
- Sustainable business model
- Generate revenue from content delivery

## Getting Started

### Quick Start: Rate Limiter Only

Enable basic rate limiting without payments:

**1. Add to `.env` file:**

```bash
# Enable rate limiting
ENABLE_RATE_LIMITER=true

# Rate limiter uses Redis by default (recommended for production)
# For development/testing only, you can override to use memory:
# RATE_LIMITER_TYPE=memory

# Configure bucket sizes and refill rates
# IP bucket: ~98 MiB capacity, ~20 KiB/s refill
RATE_LIMITER_IP_TOKENS_PER_BUCKET=100000
RATE_LIMITER_IP_REFILL_PER_SEC=20

# Resource bucket: ~976 MiB capacity, ~100 KiB/s refill
RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET=1000000
RATE_LIMITER_RESOURCE_REFILL_PER_SEC=100
```

**2. Start the gateway:**

```bash
docker-compose up -d
```

**3. Test rate limiting:**

```bash
# Make requests until you hit the limit
for i in {1..100}; do
  curl -i http://localhost:3000/YOUR_TX_ID
done

# You should eventually see:
# HTTP/1.1 429 Too Many Requests
```

**4. Monitor rate limit metrics:**

Rate limit metrics are exposed at `/ar-io/__gateway_metrics`:

```bash
# View all rate limit metrics
curl http://localhost:3000/ar-io/__gateway_metrics | grep rate_limit

# Or directly to core (port 4000)
curl http://localhost:4000/ar-io/__gateway_metrics | grep rate_limit
```

Available metrics:

- `rate_limit_exceeded_total` - Requests that exceeded rate limits
- `rate_limit_requests_total` - Total requests processed by rate limiter
- `rate_limit_bytes_blocked_total` - Bytes blocked by rate limiting
- `rate_limit_tokens_consumed_total` - Tokens consumed (by bucket/token type)

### Quick Start: Rate Limiting with x402 Payments

#### Testnet Setup (Development/Testing)

Use Base Sepolia testnet for development and testing:

**1. Prerequisites:**

- Ethereum wallet
- Testnet ETH from
  [Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
- Testnet USDC from [Circle's faucet](https://faucet.circle.com/)

**2. Add to `.env` file:**

```bash
# Minimal testnet configuration - just the essentials to get started
# For production-ready configuration, see Examples section

# Rate Limiter (required for x402)
ENABLE_RATE_LIMITER=true
RATE_LIMITER_IP_TOKENS_PER_BUCKET=100000       # ~98 MiB per IP
RATE_LIMITER_IP_REFILL_PER_SEC=20              # ~20 KiB/s refill
RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET=1000000 # ~976 MiB per resource
RATE_LIMITER_RESOURCE_REFILL_PER_SEC=100       # ~100 KiB/s refill

# x402 Payments (testnet)
ENABLE_X_402_USDC_DATA_EGRESS=true
X_402_USDC_NETWORK=base-sepolia
X_402_USDC_WALLET_ADDRESS=0xYOUR_TESTNET_WALLET
X_402_USDC_FACILITATOR_URL=https://x402.org/facilitator
X_402_USDC_PER_BYTE_PRICE=0.0000000001         # $0.10 per GB
X_402_USDC_DATA_EGRESS_MIN_PRICE=0.001         # $0.001 minimum
X_402_USDC_DATA_EGRESS_MAX_PRICE=1.00          # $1.00 maximum

# Integration: paid tier gets 10x capacity
X_402_RATE_LIMIT_CAPACITY_MULTIPLIER=10
```

**3. Start the gateway:**

```bash
docker-compose up -d
```

**4. Test the payment flow:**

```bash
# Test in browser - visit http://localhost:3000/YOUR_TX_ID
# After hitting rate limit, you'll see the paywall UI

# Or test with curl (will show 402 response with payment requirements)
curl -v http://localhost:3000/YOUR_TX_ID
```

#### Mainnet Setup (Production)

Use Base mainnet for production with real payments:

**1. Prerequisites:**

- Ethereum wallet with Base mainnet access
- Real USDC on Base network
- Coinbase Developer Platform (CDP) account (required for mainnet with Coinbase
  facilitators)

**2. CDP API keys (required for mainnet):**

- Visit [Coinbase Developer Platform](https://portal.cdp.coinbase.com/)
- Create an account and project
- Generate API keys (both public client key and secret API key)
- **Important**: Store secret keys securely, never commit to git

**3. Add to `.env` file:**

```bash
# Minimal mainnet configuration - essential settings only
# For production-ready configuration with Redis persistence and paywall customization,
# see Examples section

# Rate Limiter (required for x402)
ENABLE_RATE_LIMITER=true
RATE_LIMITER_IP_TOKENS_PER_BUCKET=100000
RATE_LIMITER_IP_REFILL_PER_SEC=20
RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET=1000000
RATE_LIMITER_RESOURCE_REFILL_PER_SEC=100

# x402 Payments (mainnet)
ENABLE_X_402_USDC_DATA_EGRESS=true
X_402_USDC_NETWORK=base
X_402_USDC_WALLET_ADDRESS=0xYOUR_MAINNET_WALLET
X_402_USDC_FACILITATOR_URL=https://facilitator.x402.rs
X_402_USDC_PER_BYTE_PRICE=0.0000000001         # $0.10 per GB (adjust as needed)
X_402_USDC_DATA_EGRESS_MIN_PRICE=0.001
X_402_USDC_DATA_EGRESS_MAX_PRICE=1.00

# Coinbase Onramp integration (required for mainnet)
X_402_CDP_CLIENT_KEY=your_public_client_key
CDP_API_KEY_SECRET_FILE=/app/secrets/cdp_secret_key
CDP_API_KEY_ID=your_api_key_id

# Integration settings
X_402_RATE_LIMIT_CAPACITY_MULTIPLIER=10
```

**4. Security best practices:**

```bash
# Create secrets directory with restricted permissions
mkdir -p ./secrets
chmod 700 ./secrets

# Store CDP secret key securely (if using Onramp)
echo "YOUR_CDP_SECRET_KEY" > ./secrets/cdp_secret_key
chmod 600 ./secrets/cdp_secret_key
```

**5. Test carefully:**

Start with small transactions and monitor payment settlement before going fully
live.

## Rate Limiter Deep Dive

### Concepts

#### Token Bucket Algorithm

The rate limiter uses the **token bucket algorithm**:

- Each bucket has a **capacity** (maximum tokens)
- Tokens **refill** at a constant rate per second
- Requests **consume** tokens based on data size
- Requests are **denied** when insufficient tokens available

**Token calculation**: `tokens = ceil(bytes / 1024)`

Example: A 5,000-byte response consumes `ceil(5000 / 1024) = 5` tokens

#### Two-Tier Limiting

The system enforces limits at two levels:

**1. Per-Resource Limits:**

- Applies to each unique resource (e.g., specific transaction ID)
- Prevents any single resource from monopolizing bandwidth
- Key format: `rl:{METHOD}:{HOST}:{PATH}:resource`
- Example: `rl:GET:example.com:/tx123:resource`

**2. Per-IP Limits:**

- Applies to each client IP address
- Prevents any single client from overwhelming the gateway
- Key format: `rl:ip:{IP_ADDRESS}`
- Example: `rl:ip:192.168.1.100`
- **Proxy/CDN Support**: IP address is extracted from proxy headers
  (`X-Forwarded-For`, `X-Real-IP`) when present, ensuring correct client
  identification behind proxies and CDNs (see
  [Proxy and CDN Support](#proxy-and-cdn-support))

**Request flow:**

1. Check IP bucket first (primary rate limit)
2. If IP bucket has tokens, check resource bucket
3. If both pass, serve request
4. If either fails, return 429 (rate limited)

**Exception**: Requests using paid tokens skip resource bucket checks.

#### Dual Token System

Each bucket contains two types of tokens:

**Regular Tokens:**

- Refill automatically based on configured rate
- Reset to capacity at bucket creation
- Consumed when paid tokens unavailable

**Paid Tokens:**

- Added through x402 payments
- Do NOT refill automatically
- Consumed after regular tokens (act as overflow capacity)
- Can exceed regular capacity

**Consumption priority:**

1. Try consuming from regular tokens first
2. If insufficient, use paid tokens
3. If still insufficient, deny request

This priority order ensures paid tokens last longer and provide better value to
paying users, as they act as overflow capacity rather than being consumed
immediately.

#### Token Prediction and Adjustment

To avoid blocking on unknown response sizes:

**1. Prediction (before streaming):**

- Predict tokens based on `Content-Length` header (if available)
- Use minimum of 1 token if size unknown
- For range requests, calculate actual range size

**2. Adjustment (after streaming):**

- Measure actual bytes transferred
- Calculate actual tokens needed
- Adjust buckets (consume more or refund difference)

This allows streaming while ensuring accurate token accounting.

### Configuration Reference

For a complete list of all rate limiter environment variables with defaults and
descriptions, see [Rate Limiter Variables](#rate-limiter-variables) in the
Reference section.

Key configuration areas:

- **Core settings**: Enable/disable enforcement, choose implementation type
  (memory vs Redis)
- **Bucket capacity**: Maximum tokens for IP and resource buckets
- **Refill rates**: How quickly tokens replenish over time
- **Redis connection**: Endpoint, TLS, and cluster configuration
- **Allowlists**: Exempt specific IPs/CIDRs or ArNS names from limiting

#### Redis Persistence Configuration

By default, Redis persistence is **disabled** in the Docker Compose
configuration to optimize performance. This means **token bucket state
(including paid tokens) is lost on restart**, similar to the memory-based rate
limiter.

If you need to preserve token bucket state across restarts (especially important
when using x402 paid tokens), you must enable Redis persistence using the
`EXTRA_REDIS_FLAGS` environment variable.

##### Why Persistence Matters

- **Paid tokens**: Users who have purchased capacity with x402 payments expect
  their paid tokens to persist across gateway restarts
- **Rate limit fairness**: Without persistence, all users get fresh buckets on
  restart, potentially allowing burst traffic that exceeds intended limits
- **User experience**: Paying users may be frustrated if their purchased
  capacity disappears during maintenance windows

##### Current Default Behavior

The default configuration in `docker-compose.yaml` line 227 is:

```yaml
command:
  redis-server --maxmemory ${REDIS_MAX_MEMORY:-256mb} --maxmemory-policy
  allkeys-lru ${EXTRA_REDIS_FLAGS:---save "" --appendonly no}
```

This sets `EXTRA_REDIS_FLAGS` to `--save "" --appendonly no`, which:

- Disables RDB snapshots (`--save ""`)
- Disables AOF persistence (`--appendonly no`)
- Prioritizes performance over durability

**Data volume**: Redis data is mounted at
`${REDIS_DATA_PATH:-./data/redis}:/data`, but without persistence enabled, this
directory remains empty.

##### Redis Persistence Options

Redis provides two persistence mechanisms that can be used independently or
together:

**1. RDB (Redis Database) - Snapshots**

- Creates point-in-time snapshots of the dataset
- Lower resource overhead (CPU and disk I/O)
- Faster restarts (compact binary format)
- **Trade-off**: Potential data loss between snapshots
- **Best for**: Acceptable to lose recent changes on crash

**2. AOF (Append-Only File) - Write Log**

- Logs every write operation
- More durable (minimal data loss)
- Larger file sizes and higher I/O overhead
- **Trade-off**: Slower performance, larger disk usage
- **Best for**: Maximum data durability required

**3. Hybrid (RDB + AOF) - Recommended**

- Uses AOF for durability, RDB for fast restarts
- Best of both approaches
- **Best for**: Production environments with paid tokens

##### Configuration Examples

To enable persistence, set `EXTRA_REDIS_FLAGS` in your `.env` file:

**No Persistence (Current Default):**

```bash
# Fastest performance, no token preservation across restarts
EXTRA_REDIS_FLAGS=--save "" --appendonly no
```

**RDB Only - Periodic Snapshots:**

```bash
# Good balance: snapshot every 5 minutes if 10 keys changed,
# or every 1 minute if 1000 keys changed
EXTRA_REDIS_FLAGS=--save 300 10 --save 60 1000

# More frequent snapshots (every minute if 1 key changed):
EXTRA_REDIS_FLAGS=--save 60 1
```

**AOF Only - Maximum Durability:**

```bash
# Sync every second (good balance of safety and performance)
EXTRA_REDIS_FLAGS=--appendonly yes --appendfsync everysec

# Sync after every write (maximum durability, slower)
EXTRA_REDIS_FLAGS=--appendonly yes --appendfsync always

# Let OS decide when to sync (faster, less safe)
EXTRA_REDIS_FLAGS=--appendonly yes --appendfsync no
```

**Hybrid - Recommended for Production:**

```bash
# Best of both: AOF for durability + RDB for fast restarts
EXTRA_REDIS_FLAGS=--save 300 10 --appendonly yes --appendfsync everysec
```

##### RDB Save Rules Explained

The RDB `--save` option takes two parameters: `seconds` and `changes`.

Format: `--save <seconds> <changes>`

- `--save 300 10`: Save if 10 or more keys changed in 300 seconds (5 minutes)
- `--save 60 1000`: Save if 1000 or more keys changed in 60 seconds (1 minute)
- Multiple rules can be specified (Redis saves if ANY rule matches)
- `--save ""`: Disable all save rules

**Common RDB configurations:**

```bash
# Conservative (less frequent saves):
EXTRA_REDIS_FLAGS=--save 900 1 --save 300 10

# Balanced (default Redis behavior):
EXTRA_REDIS_FLAGS=--save 900 1 --save 300 10 --save 60 10000

# Aggressive (more frequent saves):
EXTRA_REDIS_FLAGS=--save 300 1 --save 60 10
```

##### AOF Fsync Policies

The `--appendfsync` option controls when AOF data is written to disk:

- `always`: Sync after every write (slowest, safest)
- `everysec`: Sync every second (recommended balance)
- `no`: Let OS decide when to sync (fastest, least safe)

##### Data Volume and File Permissions

The Redis data directory is mounted at:

```bash
${REDIS_DATA_PATH:-./data/redis}:/data
```

**Default location**: `./data/redis` in your project directory

**With persistence enabled, you will see:**

- RDB: `dump.rdb` file containing snapshot
- AOF: `appendonly.aof` file containing write log

**File permissions:**

- Files are created by the Redis container user
- Ensure the directory is writable by the container
- Backup these files for disaster recovery

##### Performance Considerations

**Performance impact comparison:**

| Configuration      | Performance | Durability     | Disk Usage | Restart Speed |
| ------------------ | ----------- | -------------- | ---------- | ------------- |
| No persistence     | Fastest     | None           | Minimal    | Fastest       |
| RDB only           | Very Fast   | Snapshot-based | Low        | Fast          |
| AOF (everysec)     | Fast        | ~1s data loss  | Medium     | Medium        |
| AOF (always)       | Slower      | Maximum        | Medium     | Medium        |
| Hybrid (RDB + AOF) | Fast        | Maximum        | Higher     | Fast          |

**Recommendations:**

- **Development/testing**: Use default (no persistence) for fastest performance
- **Production without payments**: RDB only is usually sufficient
- **Production with x402 payments**: Hybrid approach recommended to preserve
  paid tokens

##### Migration Path

To enable persistence on an existing deployment:

1. **Stop the gateway** (to ensure clean state):

   ```bash
   docker-compose down
   ```

2. **Update `.env` file** with desired `EXTRA_REDIS_FLAGS`:

   ```bash
   EXTRA_REDIS_FLAGS=--save 300 10 --appendonly yes --appendfsync everysec
   ```

3. **Restart the gateway**:

   ```bash
   docker-compose up -d
   ```

4. **Verify persistence files created**:
   ```bash
   ls -lh data/redis/
   # Should see dump.rdb and/or appendonly.aof
   ```

**Note**: Existing token bucket state in memory will be lost during this
migration. Consider this when planning the maintenance window.

### Implementation Comparison

#### Memory Rate Limiter

**Pros:**

- Fast (no network overhead)
- Simple setup (no external dependencies)
- Suitable for development and testing

**Cons:**

- Not suitable for multi-node deployments
- Buckets lost on restart
- Limited by process memory
- Not recommended for production

**When to use:**

- **Development and testing only, not recommended for production**

#### Redis Rate Limiter

**Pros:**

- Supports multi-node deployments (shared state)
- Persistent across restarts (when persistence is enabled)
- Scales horizontally
- Pre-configured in Docker Compose

**Cons:**

- Network latency (Redis calls)
- Requires Redis infrastructure
- Slightly more complex setup
- Persistence disabled by default (requires configuration)

**When to use:**

- **Recommended for all production deployments**

**Note:** By default, Redis persistence is **disabled** in the Docker Compose
configuration to optimize performance. Token bucket state (including paid
tokens) will be lost on restart. See
[Redis Persistence Configuration](#redis-persistence-configuration) for how to
enable persistence if needed.

### Architecture

#### Integration with Data Handlers

The rate limiter integrates at the HTTP handler level:

```
Request → Rate Limit Check → Data Handler → Token Adjustment → Response
```

#### Metrics

The rate limiter exposes Prometheus metrics at `/ar-io/__gateway_metrics`:

**`rate_limit_exceeded_total`** (counter)

- Total requests that exceeded rate limits
- Labels:
  - `limit_type`: `ip` or `resource`
  - `domain`: Request domain/host

**`rate_limit_requests_total`** (counter)

- Total requests processed by rate limiter
- Labels:
  - `domain`: Request domain/host

**`rate_limit_bytes_blocked_total`** (counter)

- Total bytes that would have been served if not rate limited
- Labels:
  - `domain`: Request domain/host

**`rate_limit_tokens_consumed_total`** (counter)

- Total tokens consumed
- Labels:
  - `bucket_type`: `ip` or `resource`
  - `token_type`: `paid` or `regular`
  - `domain`: Request domain/host

Example PromQL queries:

```promql
# Rate of requests exceeding limits by type
rate(rate_limit_exceeded_total[5m])

# Total requests processed by rate limiter
rate(rate_limit_requests_total[5m])

# Bytes blocked per second
rate(rate_limit_bytes_blocked_total[5m])

# Paid tokens consumed per IP
rate(rate_limit_tokens_consumed_total{bucket_type="ip",token_type="paid"}[5m])

# Regular tokens consumed per resource
rate(rate_limit_tokens_consumed_total{bucket_type="resource",token_type="regular"}[5m])
```

## x402 Payment Protocol Deep Dive

### Concepts

#### Payment Flow

The complete payment flow involves several steps:

**1. Client Request (no payment):**

- Client requests content
- Gateway checks rate limits
- If limited, gateway returns 402 Payment Required
- Response includes payment requirements in `x402` format

**2. Payment Generation (client-side):**

- Client reviews payment requirements
- Client signs payment authorization (EIP-712)
- Client retries request with `X-Payment` header

**3. Payment Verification (gateway):**

- Gateway extracts payment from header
- Gateway calls facilitator `/verify` endpoint
- Facilitator checks:
  - Signature validity
  - Payment amount matches requirements
  - Payment not already settled (uniqueness)

**4. Content Delivery:**

- Gateway serves content
- Gateway measures actual bytes transferred

**5. Payment Settlement (gateway):**

- Gateway calls facilitator `/settle` endpoint
- Facilitator:
  - Marks payment as settled (prevents replay)
  - Initiates on-chain USDC transfer
  - Returns settlement receipt
- Gateway returns `X-Payment-Response` header to client

**6. Token Top-Off (if rate limiter enabled):**

- Gateway calculates tokens from payment amount
- Applies capacity multiplier (default 10x)
- Adds paid tokens to user's IP bucket

#### Browser Paywall vs API Payments

**Browser Paywall Mode:**

- Detected when request has BOTH:
  - `Accept` header includes `text/html`
  - `User-Agent` header includes `Mozilla`
- Returns HTML paywall UI (Coinbase SDK)
- User connects wallet in browser
- Payment auto-generated and submitted
- Redirect mechanism to avoid blob URL issues

**API Payment Mode:**

- Any request that doesn't meet browser detection criteria
- Returns JSON 402 response with requirements
- Client uses `x402-fetch` or similar library
- Payment header sent in subsequent request

#### Facilitator Role

The **facilitator** is a service that:

- Verifies payment signatures
- Tracks payment uniqueness (prevents replay attacks)
- Settles payments on-chain
- Returns settlement receipts

For a list of available facilitators with URLs, supported networks, and
authentication requirements, see
[Facilitator Comparison](#facilitator-comparison) in the Reference section.

**Note**: CDP keys (`X_402_CDP_CLIENT_KEY`, `CDP_API_KEY_SECRET`, etc.) are for
**Coinbase Onramp integration** (browser paywall with easy USDC purchase), not
for facilitator authentication.

### Network Selection

#### Base Sepolia (Testnet)

**Characteristics:**

- Free testnet USDC (no real value)
- Default facilitator available
- No CDP API key required
- Suitable for development and testing

**Setup:**

```bash
X_402_USDC_NETWORK=base-sepolia
X_402_USDC_FACILITATOR_URL=https://x402.org/facilitator
```

**Getting Testnet USDC:**

1. Get Base Sepolia ETH:
   https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
2. Get testnet USDC: https://faucet.circle.com/

#### Base (Mainnet)

**Characteristics:**

- Real USDC (actual value)
- Requires CDP API key (for official facilitator) or alternative facilitator
- Production-ready

**Setup with official facilitator:**

```bash
X_402_USDC_NETWORK=base
X_402_USDC_FACILITATOR_URL=https://facilitator.x402.rs
X_402_CDP_CLIENT_KEY=your_public_client_key
```

**Setup with alternative facilitator:**

```bash
X_402_USDC_NETWORK=base
X_402_USDC_FACILITATOR_URL=https://facilitator.x402.rs
# No CDP key needed
```

### Configuration Reference

For a complete list of all x402 environment variables with defaults and
descriptions, see [x402 Variables](#x402-variables) in the Reference section.

Key configuration areas:

- **Core settings**: Enable/disable payments, network selection, wallet address,
  facilitator URL
- **Pricing**: Per-byte price, min/max price limits
- **CDP API keys**: Required for Coinbase Onramp integration on mainnet (browser
  paywall)
- **Settlement**: Timeout configuration
- **Paywall customization**: App name, logo, session token endpoint

#### Price Calculation

Prices are calculated using this formula:

```javascript
const priceUSD = contentLength * perBytePrice;
const clampedPrice = Math.min(Math.max(priceUSD, minPrice), maxPrice);
```

Examples for common pricing:

- $0.10/GB: `X_402_USDC_PER_BYTE_PRICE=0.0000000001`
- $0.50/GB: `X_402_USDC_PER_BYTE_PRICE=0.0000000005`
- $1.00/GB: `X_402_USDC_PER_BYTE_PRICE=0.000000001`

#### CDP API Key Security

**IMPORTANT**: The CDP secret keys (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`,
`CDP_API_KEY_SECRET_FILE`) are **SENSITIVE SECRETS** required for Coinbase
Onramp integration. The public client key (`X_402_CDP_CLIENT_KEY`) is safe for
client-side use.

Security requirements:

- Store secrets in secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)
- Use file-based config with restricted permissions (`chmod 600`)
- **Never commit to git or expose in logs**
- Apply principle of least privilege
- Rotate regularly

### Architecture

#### Integration with Rate Limiter

When both features enabled:

1. Payment settled successfully
2. Gateway extracts payment amount (atomic USDC units)
3. Gateway calculates equivalent tokens:
   ```javascript
   paymentUSD = atomicAmount / 1_000_000; // USDC has 6 decimals
   contentLength = paymentUSD / perBytePrice;
   tokens = ceil(contentLength / 1024);
   tokensWithMultiplier = tokens * capacityMultiplier;
   ```
4. Gateway adds paid tokens to IP bucket
5. Paid tokens consumed first on subsequent requests

#### Browser Paywall Rendering

For browser requests (Accept includes `text/html` AND User-Agent includes
`Mozilla`):

1. Gateway returns HTML with Coinbase SDK
2. SDK prompts user to connect wallet
3. User approves payment (EIP-712 signature)
4. SDK submits payment to redirect endpoint
5. Gateway verifies and settles payment
6. Gateway redirects to original URL with topped-off bucket

## Integration Topics

### Payment + Rate Limiter Integration

#### Capacity Multiplier

**`X_402_RATE_LIMIT_CAPACITY_MULTIPLIER`** (number, default: `10`)

- Multiplier applied to paid token amounts
- Provides premium tier with enhanced limits
- Example: $1 payment with default pricing ($0.10/GB):
  - Pays for ~10 GB of data
  - Token calculation: `ceil(10 * 1024^3 / 1024) = 10485760` tokens
  - With 10x multiplier: `104857600` tokens (~100 GB worth)

#### Paid Token Priority

Tokens consumed in this order:

1. **Regular tokens first** (consumed before paid tokens)
2. **Paid tokens second** (used when regular tokens insufficient)

This prioritization:

- Maximizes value to paying users (paid tokens last longer)
- Paid tokens act as overflow capacity rather than primary pool
- Regular tokens still refill over time for baseline access
- Provides better long-term value for paid tier

#### Resource Limit Bypass

Requests using paid tokens **bypass per-resource limits**:

- Only IP bucket checked (not resource bucket)
- Prevents payment from being blocked by popular resource limits
- Still enforces fair IP-level limits

Logic:

```javascript
if (paidTokensConsumed === 0) {
  // Check resource bucket
} else {
  // Skip resource bucket check
}
```

### Client Implementation

#### Using x402-fetch

The `x402-fetch` library provides automatic payment handling:

**Installation:**

```bash
npm install x402-fetch viem
```

**Usage:**

```typescript
import { wrapFetchWithPayment } from 'x402-fetch';
import { privateKeyToAccount } from 'viem/accounts';

// Create account from private key
const account = privateKeyToAccount('0xYOUR_PRIVATE_KEY');

// Wrap fetch with payment support
const fetchWithPayment = wrapFetchWithPayment(fetch, account);

// Use like normal fetch - payments automatic
const response = await fetchWithPayment('http://gateway.example.com/tx123');
const data = await response.arrayBuffer();
```

See `scripts/x402/fetch-data.ts` for complete example.

#### Payment Header Format

When implementing custom client:

**Request:**

```http
GET /tx123 HTTP/1.1
X-Payment: <base64-encoded-payment-payload>
```

**Payment payload structure** (see x402 SDK for encoding):

- Scheme (exact, range, etc.)
- Network (base, base-sepolia)
- Authorization (EIP-712 signature)
- Asset (USDC contract address)
- Amount (atomic units)

**Response:**

```http
HTTP/1.1 200 OK
X-Payment-Response: <base64-encoded-settlement-result>
```

#### Error Handling

**402 Payment Required:**

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "100000",
      "payTo": "0x...",
      "asset": "0x...",
      "resource": "http://gateway.example.com/tx123",
      "mimeType": "application/octet-stream",
      "maxTimeoutSeconds": 300
    }
  ],
  "error": "insufficient_payment",
  "message": "Payment required"
}
```

**429 Rate Limited:**

```json
{
  "error": "Rate limit exceeded",
  "limitType": "ip"
}
```

**Retry strategy:**

1. On 402: Generate payment, retry with `X-Payment` header
2. On 429: Exponential backoff or payment (if configured)
3. On 5xx: Exponential backoff

### Testnet to Mainnet Migration

#### Checklist

- [ ] Obtain CDP API keys from Coinbase Developer Platform (required for
      mainnet)
- [ ] Configure CDP secret key securely (`CDP_API_KEY_SECRET_FILE` recommended)
- [ ] Update network: `X_402_USDC_NETWORK=base`
- [ ] Update wallet to mainnet address with real USDC
- [ ] Choose facilitator (official or alternative)
- [ ] Adjust pricing for mainnet usage
- [ ] Test with small transactions first
- [ ] Monitor payment settlement and errors
- [ ] Set up alerting for payment failures
- [ ] Document pricing for users

#### Configuration Changes

**Testnet:**

```bash
# Rate limiter (required for x402)
ENABLE_RATE_LIMITER=true

# x402 Payments
ENABLE_X_402_USDC_DATA_EGRESS=true
X_402_USDC_NETWORK=base-sepolia
X_402_USDC_WALLET_ADDRESS=0xYOUR_TESTNET_WALLET
X_402_USDC_FACILITATOR_URL=https://x402.org/facilitator
```

**Mainnet:**

```bash
# Rate limiter (required for x402)
ENABLE_RATE_LIMITER=true

# x402 Payments
ENABLE_X_402_USDC_DATA_EGRESS=true
X_402_USDC_NETWORK=base
X_402_USDC_WALLET_ADDRESS=0xYOUR_MAINNET_WALLET
X_402_USDC_FACILITATOR_URL=https://facilitator.x402.rs
# Coinbase Onramp integration (required for mainnet)
X_402_CDP_CLIENT_KEY=your_public_client_key
CDP_API_KEY_SECRET_FILE=/app/secrets/cdp_secret_key
CDP_API_KEY_ID=your_api_key_id
```

### Security Considerations

#### Wallet Private Key Management

**Never:**

- Commit private keys to git
- Log private keys
- Store in plain text configuration files
- Share or expose publicly

**Always:**

- Use environment variables or secure files
- Restrict file permissions: `chmod 600`
- Use secrets managers in production
- Rotate keys periodically
- Use separate keys for test and production

#### CDP API Key Protection (Onramp Integration)

The CDP secret API keys (`CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`) are
**SENSITIVE SECRETS** (the public client key `X_402_CDP_CLIENT_KEY` is safe for
client-side use):

**Storage:**

- **Recommended**: File-based with restricted permissions
  ```bash
  mkdir -p ./secrets
  chmod 700 ./secrets
  echo "YOUR_SECRET_KEY" > ./secrets/cdp_secret_key
  chmod 600 ./secrets/cdp_secret_key
  ```
- **Alternative**: Environment variable (less secure)
- **Production**: Use secrets manager (AWS Secrets Manager, HashiCorp Vault)

**Access Control:**

- Apply principle of least privilege
- Limit access to operators only
- Audit access logs
- Rotate regularly

**Logging:**

- Never log the secret key values
- Mask in error messages
- Exclude from diagnostic output
- Public client key (`X_402_CDP_CLIENT_KEY`) is safe to log

#### Redirect URL Validation

The paywall redirect endpoint validates URLs to prevent XSS:

**Allowed:**

- `http://` and `https://` absolute URLs
- Same-origin relative paths (starting with `/`)

**Blocked:**

- `javascript:` URLs
- `data:` URLs
- Scheme-relative URLs (`//example.com`)
- Non-HTTP(S) schemes

#### Payment Verification

The facilitator provides several security guarantees:

**Signature verification:**

- EIP-712 typed structured data signing
- Verifies payment signed by claimed payer
- Prevents payment forgery

**Uniqueness:**

- Tracks settled payments
- Prevents replay attacks
- Each payment can only be settled once

**Amount verification:**

- Ensures payment amount matches requirements
- Prevents underpayment

### Proxy and CDN Support

When deploying AR.IO gateways behind proxies, load balancers, or CDNs (like
nginx, Cloudflare, AWS CloudFront, or Fastly), the rate limiter automatically
extracts the real client IP address from standard proxy headers. This ensures
that rate limiting and x402 payments work correctly even when the gateway
doesn't receive direct client connections.

#### How IP Extraction Works

The rate limiter extracts client IP addresses in the following priority order:

1. **X-Forwarded-For header**: Extracts the first (leftmost) IP address from the
   header chain
   - Format: `X-Forwarded-For: client, proxy1, proxy2`
   - Uses: `client` (203.0.113.42)
2. **X-Real-IP header**: Uses this header when X-Forwarded-For is not present
   - Format: `X-Real-IP: 203.0.113.42`
3. **Direct connection IP**: Uses `socket.remoteAddress` when no proxy headers
   are present, then falls back to `req.ip` if available

**Important**: The same IP extraction logic is used for:

- **Rate limit bucket keys** (`rl:ip:{IP_ADDRESS}`)
- **x402 payment crediting** (tokens added to correct client's bucket)
- **IP allowlist checks** (exempting specific clients from limits)

This consistency ensures that if a client is allowlisted, their rate limit
bucket is also correctly identified, and any payments they make are properly
credited.

#### IPv6 Support

The gateway automatically normalizes IPv4-mapped IPv6 addresses to their IPv4
equivalents:

- `::ffff:192.0.2.1` normalizes to `192.0.2.1`
- Ensures consistent bucket identification regardless of address format

#### Example Proxy Configurations

**Nginx:**

```nginx
location / {
    proxy_pass http://ar-io-gateway:3000;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Host $host;
}
```

**Cloudflare:**

Cloudflare automatically adds X-Forwarded-For headers. No special configuration
needed. The gateway extracts the real client IP from X-Forwarded-For.

**AWS Application Load Balancer:**

ALBs automatically add X-Forwarded-For headers. Ensure your target group is
configured to preserve client IPs.

#### Security Considerations

**Header Trust**: The gateway trusts X-Forwarded-For and X-Real-IP headers by
default. This is generally safe when:

- Your gateway is behind a trusted proxy/CDN
- The proxy strips existing headers from client requests
- External clients cannot directly access your gateway

**Direct Exposure**: If your gateway is directly exposed to the internet without
a proxy:

- Clients could forge X-Forwarded-For headers
- Consider using firewall rules to only allow traffic from your proxy IPs
- Or configure your proxy to strip untrusted headers

**Express Trust Proxy**: The gateway does NOT use Express's `trust proxy`
setting. IP extraction is handled manually via the `extractAllClientIPs()`
utility function for more explicit control and security.

#### Protocol Configuration for Proxies

When your gateway is behind a reverse proxy/CDN that terminates TLS (HTTPS), the
gateway receives HTTP connections from the proxy but needs to generate HTTPS URLs
in x402 payment responses. Set the `SANDBOX_PROTOCOL` environment variable to
ensure correct protocol in resource URLs:

```bash
SANDBOX_PROTOCOL=https
```

**Why this is needed**:

- Proxy terminates TLS and forwards HTTP to gateway
- Gateway's `req.protocol` returns 'http' (the proxy-to-gateway connection)
- x402 payment responses need to reference the client-facing HTTPS URL
- `SANDBOX_PROTOCOL` overrides the detected protocol

**Example x402 response without configuration**:

```json
{
  "resource": "http://your-gateway.com/raw/TX_ID"  ❌ Wrong protocol
}
```

**Example x402 response with `SANDBOX_PROTOCOL=https`**:

```json
{
  "resource": "https://your-gateway.com/raw/TX_ID"  ✅ Correct protocol
}
```

**Note**: This setting also affects ArNS sandbox redirect URLs.

#### Troubleshooting Proxy IP Extraction

**Symptom**: All clients share the same rate limit bucket behind a proxy

**Diagnosis**:

```bash
# Check if X-Forwarded-For is being sent
curl -H "X-Forwarded-For: 203.0.113.42" https://your-gateway.com/tx_id

# Monitor rate limiter logs
docker-compose logs -f core | grep "IP limit"
```

**Solution**: Verify your proxy is setting X-Forwarded-For or X-Real-IP headers
correctly.

**Symptom**: x402 payments credit the wrong IP address

**Cause**: Payment requests use the same IP extraction logic as rate limiting.
If rate limiting works correctly, payments will too.

**Solution**: Ensure proxy headers are configured correctly (see above).

### CDN Caching Considerations

When deploying AR.IO gateways behind a CDN (like Cloudflare, Fastly, or AWS
CloudFront), cache behavior can interfere with rate limiting and x402 payment
enforcement. By default, gateways set `Cache-Control: public` headers, allowing
CDNs to cache responses and serve them to multiple users without hitting your
origin server.

**The Problem:**

- CDN caches bypass your gateway's rate limiter
- Multiple users can access rate-limited content from CDN cache
- x402 payment requirements are bypassed when CDN serves cached responses
- First user pays, subsequent users get free access from CDN cache

**The Solution:**

Use `CACHE_PRIVATE_SIZE_THRESHOLD` and `CACHE_PRIVATE_CONTENT_TYPES` to
automatically mark specific responses with `Cache-Control: private`, preventing
CDN caching while still allowing browser caching.

#### Size-Based Private Caching

**`CACHE_PRIVATE_SIZE_THRESHOLD`** (number, default: `104857600` = 100 MB)

Automatically sets `Cache-Control: private` for responses exceeding this size in
bytes.

**Example configurations:**

```bash
# Prevent CDN caching of responses over 50 MB
CACHE_PRIVATE_SIZE_THRESHOLD=52428800

# Prevent CDN caching of responses over 500 MB
CACHE_PRIVATE_SIZE_THRESHOLD=524288000

# Prevent CDN caching of all responses (set to 0)
CACHE_PRIVATE_SIZE_THRESHOLD=0
```

**Use cases:**

- **Large file protection:** Prevent CDN from serving large video/image files
  that should be rate limited
- **Bandwidth control:** Ensure high-bandwidth content respects payment
  requirements
- **Fair usage:** Prevent single payment from benefiting unlimited CDN-cached
  users

#### Content-Type-Based Private Caching

**`CACHE_PRIVATE_CONTENT_TYPES`** (string, default: `""`)

Comma-separated list of content types that should use `Cache-Control: private`.
Supports wildcard patterns.

**Example configurations:**

```bash
# Prevent CDN caching of images
CACHE_PRIVATE_CONTENT_TYPES="image/*"

# Prevent CDN caching of video and audio
CACHE_PRIVATE_CONTENT_TYPES="video/*,audio/*"

# Prevent CDN caching of specific types
CACHE_PRIVATE_CONTENT_TYPES="image/png,video/mp4,application/json"

# Prevent CDN caching of all media
CACHE_PRIVATE_CONTENT_TYPES="image/*,video/*,audio/*"
```

**Wildcard patterns:**

- `*` matches any characters within a segment (not across `/`)
- `image/*` matches `image/png`, `image/jpeg`, `image/webp`, etc.
- `application/*` matches `application/json`, `application/pdf`, etc.

**Use cases:**

- **Media monetization:** Ensure video/image content respects x402 payments
- **API protection:** Prevent CDN from caching dynamic API responses
- **Selective caching:** Allow text/HTML caching but require payment for media

#### Combined Strategy

For maximum protection, combine both size and content-type based rules:

```bash
# Rate limiter (required)
ENABLE_RATE_LIMITER=true

# x402 payments
ENABLE_X_402_USDC_DATA_EGRESS=true

# CDN cache control - apply BOTH conditions:
# - Responses over 10 MB become private
CACHE_PRIVATE_SIZE_THRESHOLD=10485760
# - All media types become private
CACHE_PRIVATE_CONTENT_TYPES="image/*,video/*,audio/*"
```

**Logic:** Response uses `private` if **either** condition matches:

- Size exceeds threshold, **OR**
- Content-Type matches a pattern

#### Behavior Details

**Header transformation:**

```
# Before (default):
Cache-Control: public, max-age=2592000, immutable

# After (when conditions met):
Cache-Control: private, max-age=2592000, immutable
```

**Other directives preserved:**

- `max-age` values unchanged
- `immutable` directive preserved for stable data
- Only `public` → `private` transformation applied

**Browser caching still works:**

- `private` only prevents shared caches (CDNs)
- Browser (private) caches still work normally
- Users still get fast repeat access
- Only prevents cross-user CDN caching

#### Important Notes

**Rate limiter dependency:**

These settings only have effect when `ENABLE_RATE_LIMITER=true`. A warning is
logged at startup if configured without rate limiting enabled.

**No impact on non-CDN deployments:**

- Browser caching behavior unchanged
- Direct gateway access unaffected
- Only changes shared cache (CDN) behavior

**Performance considerations:**

- CDN cache bypass increases origin traffic
- Consider your infrastructure capacity
- Monitor bandwidth and request rates
- Adjust thresholds based on usage patterns

**Testing:**

```bash
# Check Cache-Control header for large file
curl -I http://gateway.example.com/large-file-id

# Check Cache-Control header for image
curl -I http://gateway.example.com/image-id

# Verify payment required after cache
curl -I http://gateway.example.com/paid-content-id
```

## Reference

### Environment Variables Quick Reference

#### Rate Limiter Variables

| Variable                                  | Type    | Default                                 | Description                              |
| ----------------------------------------- | ------- | --------------------------------------- | ---------------------------------------- |
| `ENABLE_RATE_LIMITER`                     | boolean | `false`                                 | Enable rate limiting enforcement         |
| `RATE_LIMITER_TYPE`                       | string  | `redis` (docker), `memory` (standalone) | Implementation type: `memory` or `redis` |
| `RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET` | number  | `1000000`                               | Resource bucket capacity (~976 MiB)      |
| `RATE_LIMITER_RESOURCE_REFILL_PER_SEC`    | number  | `100`                                   | Resource refill rate (~100 KiB/s)        |
| `RATE_LIMITER_IP_TOKENS_PER_BUCKET`       | number  | `100000`                                | IP bucket capacity (~98 MiB)             |
| `RATE_LIMITER_IP_REFILL_PER_SEC`          | number  | `20`                                    | IP refill rate (~20 KiB/s)               |
| `RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST`    | string  | `""`                                    | Comma-separated IP/CIDR allowlist        |
| `RATE_LIMITER_ARNS_ALLOWLIST`             | string  | `""`                                    | Comma-separated ArNS name allowlist      |
| `RATE_LIMITER_REDIS_ENDPOINT`             | string  | `redis://redis:6379`                    | Redis connection URL                     |
| `RATE_LIMITER_REDIS_USE_TLS`              | boolean | `false`                                 | Enable TLS for Redis                     |
| `RATE_LIMITER_REDIS_USE_CLUSTER`          | boolean | `false`                                 | Use Redis cluster mode                   |
| `CACHE_PRIVATE_SIZE_THRESHOLD`            | number  | `104857600` (100 MB)                    | Size threshold for private Cache-Control |
| `CACHE_PRIVATE_CONTENT_TYPES`             | string  | `""`                                    | Content types for private Cache-Control  |

#### x402 Variables

| Variable                               | Type       | Default                        | Description                          |
| -------------------------------------- | ---------- | ------------------------------ | ------------------------------------ |
| `ENABLE_X_402_USDC_DATA_EGRESS`        | boolean    | `false`                        | Enable x402 payments                 |
| `X_402_USDC_NETWORK`                   | string     | `base-sepolia`                 | Network: `base` or `base-sepolia`    |
| `X_402_USDC_WALLET_ADDRESS`            | hex string | undefined                      | Payment receiving wallet (0x...)     |
| `X_402_USDC_FACILITATOR_URL`           | URL        | `https://x402.org/facilitator` | Facilitator endpoint                 |
| `X_402_USDC_PER_BYTE_PRICE`            | number     | `0.0000000001`                 | Price per byte ($0.10/GB)            |
| `X_402_USDC_DATA_EGRESS_MIN_PRICE`     | number     | `0.001`                        | Minimum price per request            |
| `X_402_USDC_DATA_EGRESS_MAX_PRICE`     | number     | `1.00`                         | Maximum price per request            |
| `X_402_RATE_LIMIT_CAPACITY_MULTIPLIER` | number     | `10`                           | Paid tier capacity multiplier        |
| `X_402_USDC_SETTLE_TIMEOUT_MS`         | number     | `5000`                         | Settlement timeout (ms)              |
| `X_402_CDP_CLIENT_KEY`                 | string     | undefined                      | Public CDP client key (Onramp)       |
| `CDP_API_KEY_ID`                       | string     | undefined                      | **SECRET**: CDP API key ID (Onramp)  |
| `CDP_API_KEY_SECRET`                   | string     | undefined                      | **SECRET**: CDP API secret (Onramp)  |
| `CDP_API_KEY_SECRET_FILE`              | path       | undefined                      | **SECRET**: CDP secret file (Onramp) |
| `X_402_APP_NAME`                       | string     | `"AR.IO Gateway"`              | Paywall app name                     |
| `X_402_APP_LOGO`                       | URL        | undefined                      | Paywall logo URL                     |
| `X_402_SESSION_TOKEN_ENDPOINT`         | URL        | undefined                      | Custom session token endpoint        |

### Discovering Gateway Configuration via /ar-io/info

The AR.IO Gateway exposes rate limiter and x402 configuration through the
`/ar-io/info` endpoint, enabling programmatic discovery of gateway capabilities,
pricing, and limits.

#### Response Structure

When features are enabled, the endpoint includes optional `rateLimiter` and
`x402` objects:

```bash
curl https://your-gateway.com/ar-io/info
```

**Example Response** (both features enabled):

```json
{
  "wallet": "...",
  "processId": "...",
  "ans104UnbundleFilter": {},
  "ans104IndexFilter": {},
  "supportedManifestVersions": ["0.1.0", "0.2.0"],
  "release": "r123",
  "rateLimiter": {
    "enabled": true,
    "dataEgress": {
      "buckets": {
        "resource": {
          "capacity": 1000000,
          "refillRate": 100,
          "capacityBytes": 1024000000,
          "refillRateBytesPerSec": 102400
        },
        "ip": {
          "capacity": 100000,
          "refillRate": 20,
          "capacityBytes": 102400000,
          "refillRateBytesPerSec": 20480
        }
      }
    }
  },
  "x402": {
    "enabled": true,
    "network": "base-sepolia",
    "walletAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    "facilitatorUrl": "https://x402.org/facilitator",
    "dataEgress": {
      "pricing": {
        "perBytePrice": "0.0000000001",
        "minPrice": "0.001000",
        "maxPrice": "1.000000",
        "currency": "USDC",
        "exampleCosts": {
          "1KB": 0.001,
          "1MB": 0.000102,
          "1GB": 0.107374
        }
      },
      "rateLimiterCapacityMultiplier": 10
    }
  }
}
```

#### Field Descriptions

**rateLimiter** (optional, only present when `ENABLE_RATE_LIMITER=true`):

- `enabled`: Always `true` when present
- `dataEgress.buckets.resource`: Per-resource (transaction ID) rate limits
  - `capacity`: Maximum tokens (1 token = 1 KiB)
  - `refillRate`: Tokens added per second
  - `capacityBytes`: Convenience field (capacity × 1024)
  - `refillRateBytesPerSec`: Convenience field (refillRate × 1024)
- `dataEgress.buckets.ip`: Per-IP address rate limits (same structure as
  resource)

**x402** (optional, only present when `ENABLE_X_402_USDC_DATA_EGRESS=true`):

- `enabled`: Always `true` when present
- `network`: Blockchain network (`base` or `base-sepolia`)
- `walletAddress`: Gateway wallet address for receiving payments
- `facilitatorUrl`: x402 facilitator service URL
- `dataEgress.pricing`:
  - `perBytePrice`: Price in USDC per byte (string, formatted to avoid
    scientific notation)
  - `minPrice`: Minimum price in USDC per request (string, 6 decimal precision)
  - `maxPrice`: Maximum price in USDC per request (string, 6 decimal precision)
  - `currency`: Always `USDC`
  - `exampleCosts`: Pre-calculated costs for common sizes (1KB, 1MB, 1GB) as
    numbers
- `dataEgress.rateLimiterCapacityMultiplier`: Capacity multiplier for paid tier
  (default 10x)

#### Use Cases

**1. Pricing Display**

Show accurate pricing to users before they hit rate limits:

```typescript
const info = await fetch('https://gateway.com/ar-io/info').then((r) =>
  r.json(),
);

if (info.x402?.dataEgress?.pricing) {
  const { perBytePrice, minPrice, exampleCosts } = info.x402.dataEgress.pricing;
  console.log(`1GB costs ${exampleCosts['1GB']} USDC`);
}
```

**2. Rate Limit Awareness**

Clients can adapt behavior based on limits:

```typescript
if (info.rateLimiter?.dataEgress?.buckets) {
  const ipLimit = info.rateLimiter.dataEgress.buckets.ip;
  console.log(`Free tier: ${ipLimit.capacityBytes} bytes capacity`);
  console.log(`Refills at: ${ipLimit.refillRateBytesPerSec} bytes/sec`);
}
```

**3. Gateway Capability Discovery**

Determine what features a gateway supports:

```typescript
const supportsPayments = !!info.x402;
const supportsRateLimiting = !!info.rateLimiter;
const isPaidTierAvailable = supportsPayments && supportsRateLimiting;
```

### Network Comparison

| Feature                      | Base Sepolia (Testnet)            | Base (Mainnet)                                 |
| ---------------------------- | --------------------------------- | ---------------------------------------------- |
| **Purpose**                  | Development, testing              | Production monetization                        |
| **USDC**                     | Free testnet USDC                 | Real USDC (costs money)                        |
| **USDC Faucet**              | https://faucet.circle.com/        | N/A (purchase required)                        |
| **CDP API Key (Onramp)**     | Optional                          | Required (for Coinbase facilitators)           |
| **Default Facilitator**      | https://x402.org/facilitator      | Must configure                                 |
| **Alternative Facilitators** | facilitator.x402.rs               | facilitator.x402.rs, facilitator.payai.network |
| **Config**                   | `X_402_USDC_NETWORK=base-sepolia` | `X_402_USDC_NETWORK=base`                      |
| **Risk**                     | No financial risk                 | Real financial transactions                    |
| **Blockchain**               | Base Sepolia testnet              | Base mainnet                                   |

### Facilitator Comparison

| Facilitator           | URL                               | Networks Supported | Auth Required | Notes                           |
| --------------------- | --------------------------------- | ------------------ | ------------- | ------------------------------- |
| **Coinbase Official** | https://x402.org/facilitator      | base-sepolia       | No            | Default for testnet             |
| **x402.rs**           | https://facilitator.x402.rs       | base, base-sepolia | No            | No authentication needed        |
| **payai.network**     | https://facilitator.payai.network | base, base-sepolia | Varies        | Check facilitator documentation |

**Note**: CDP keys are for Coinbase Onramp integration (browser paywall with
easy USDC purchase), not for facilitator authentication.

## Troubleshooting

### Rate Limiter Issues

#### Limits Not Being Enforced

**Symptom**: Requests never return 429, even when exceeding limits

**Possible causes:**

1. `ENABLE_RATE_LIMITER=false` (monitoring mode)
2. IP is allowlisted
3. ArNS name is allowlisted

**Solutions:**

- Check `ENABLE_RATE_LIMITER` is set to `true`
- Review allowlists: `RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST`,
  `RATE_LIMITER_ARNS_ALLOWLIST`
- Check logs for rate limit checks: `grep -i "rate limit" logs/core.log`

#### Tokens Not Refilling

**Symptom**: Bucket stays empty even after waiting

**Possible causes:**

1. Refill rate set to 0
2. Redis connection issues (Redis mode)
3. Clock skew

**Solutions:**

- Verify refill rates > 0:
  - `RATE_LIMITER_IP_REFILL_PER_SEC`
  - `RATE_LIMITER_RESOURCE_REFILL_PER_SEC`
- Check Redis connectivity: `redis-cli ping`
- Verify system time is correct: `date`

#### Redis Connection Errors

**Symptom**: Errors in logs about Redis connectivity

**Solutions:**

- Verify Redis is running: `docker-compose ps redis`
- Check Redis endpoint: `RATE_LIMITER_REDIS_ENDPOINT`
- Test Redis connection: `redis-cli -u $RATE_LIMITER_REDIS_ENDPOINT ping`
- Check Redis logs: `docker-compose logs redis`

#### Token Buckets Reset After Restart

**Symptom**: Token bucket state (including paid tokens) is lost when gateway
restarts. Users who purchased capacity with x402 payments must pay again.

**Cause**: Redis persistence is disabled by default to optimize performance.

**Solution**: Enable Redis persistence to preserve token bucket state across
restarts. See
[Redis Persistence Configuration](#redis-persistence-configuration) for detailed
instructions on:

- Why persistence matters for paid tokens
- Persistence options (RDB, AOF, Hybrid)
- Configuration examples
- Migration steps

**Quick fix for production**:

```bash
# Add to .env file
EXTRA_REDIS_FLAGS=--save 300 10 --appendonly yes --appendfsync everysec

# Restart gateway
docker-compose down && docker-compose up -d
```

### x402 Payment Issues

#### Paywall Never Appears / 402 Responses Not Sent

**Symptom**: x402 is enabled but requests never return 402 Payment Required
responses

**Note**: As of recent versions, the application will **fail to start** if x402
is enabled without the rate limiter. You will see this error:

```
Error: ENABLE_X_402_USDC_DATA_EGRESS requires ENABLE_RATE_LIMITER to be enabled.
x402 payments are not a standalone feature - they work as an extension of the
rate limiting system. Set ENABLE_RATE_LIMITER=true to enable x402 payments.
```

If your application starts successfully, the rate limiter is properly enabled.

**Possible causes for missing 402 responses:**

1. Rate limits not being exceeded
2. Payment processor not initialized correctly

**Solutions:**

- **Verify rate limits are being exceeded**: Make enough requests to exceed the
  configured limits. x402 only sends 402 responses when rate limits are
  exceeded.
- **Check logs** for payment processor initialization:
  ```bash
  grep -i "payment processor" logs/core.log
  ```

#### Payment Verification Failed

**Symptom**: 402 errors even with valid payment

**Possible causes:**

1. Network mismatch (testnet payment on mainnet gateway)
2. Signature invalid
3. Payment already settled
4. Facilitator unreachable

**Solutions:**

- Verify network matches:
  - Client: Check wallet network (Base vs Base Sepolia)
  - Gateway: Check `X_402_USDC_NETWORK`
- Check facilitator connectivity:
  ```bash
  curl https://x402.org/facilitator/health
  ```
- Review gateway logs for verification errors:
  ```bash
  grep "Payment verification" logs/core.log
  ```
- Try fresh payment (may be replay attempt)

#### Settlement Timeout

**Symptom**: 500 errors with "Settlement timeout" in logs

**Possible causes:**

1. Facilitator slow or unreachable
2. Settlement timeout too short
3. Network congestion (mainnet)

**Solutions:**

- Check facilitator status
- Increase `X_402_USDC_SETTLE_TIMEOUT_MS` (default 5000ms)
- Try alternative facilitator
- Review facilitator logs (if self-hosted)

#### CDP API Key Errors (Onramp Integration)

**Symptom**: Errors when using browser paywall with Onramp

**Possible causes:**

1. Invalid or expired CDP API keys
2. Keys not provided (when Onramp integration enabled)
3. File permissions preventing key read

**Solutions:**

- Verify CDP keys are valid (check Coinbase Developer Platform)
- Check secret key file exists and is readable:
  ```bash
  ls -l ./secrets/cdp_secret_key
  cat ./secrets/cdp_secret_key
  ```
- Verify environment variables set correctly:
  - `X_402_CDP_CLIENT_KEY` (public client key)
  - `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (or `CDP_API_KEY_SECRET_FILE`)
- Note: CDP keys are required for mainnet deployments. On testnet, they may be
  omitted if Onramp integration is not needed

#### Paywall Not Displaying (Browser)

**Symptom**: Browser shows JSON instead of paywall UI

**Possible causes:**

Browser detection requires BOTH headers - missing or incorrect values will show
JSON instead:

1. `Accept` header missing or doesn't include `text/html`
2. `User-Agent` header missing or doesn't include `Mozilla`

**Solutions:**

- Verify request headers in browser dev tools (both required):
  - `Accept` must include `text/html`
  - `User-Agent` must include `Mozilla`
- Try different browser
- Check gateway logs for paywall rendering

#### Wallet Address Invalid

**Symptom**: Startup error about invalid wallet address

**Solutions:**

- Verify format: Must be `0x` followed by 40 hex characters
- Example: `0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb`
- Check for typos or missing characters

### Integration Issues

#### Paid Tokens Not Being Added

**Symptom**: Payments succeed but rate limits not improved

**Possible causes:**

1. Rate limiter disabled
2. Integration issue

**Solutions:**

- Verify both features enabled:
  - `ENABLE_RATE_LIMITER=true`
  - `ENABLE_X_402_USDC_DATA_EGRESS=true`
- Check logs for "Topped off bucket" messages:
  ```bash
  grep "Topped off" logs/core.log
  ```
- Review metrics for paid token consumption:
  ```bash
  curl http://localhost:3000/ar-io/__gateway_metrics | grep 'token_type="paid"'
  ```

#### Resource Limits Still Apply (Paid Requests)

**Symptom**: Paid requests still hitting resource limits

**Possible causes:**

1. Payment not detected
2. Token accounting issue

**Solutions:**

- Verify payment header present: `X-Payment: ...`
- Check if paid tokens actually consumed (should skip resource check)
- Review logs for payment processing in redirect endpoint

### Monitoring and Debugging

#### View Rate Limit Metrics

```bash
# View all rate limit metrics
curl -s http://localhost:3000/ar-io/__gateway_metrics | grep rate_limit

# Requests that exceeded rate limits
curl -s http://localhost:3000/ar-io/__gateway_metrics | grep rate_limit_exceeded_total

# Total requests processed by rate limiter
curl -s http://localhost:3000/ar-io/__gateway_metrics | grep rate_limit_requests_total

# Bytes blocked by rate limiting
curl -s http://localhost:3000/ar-io/__gateway_metrics | grep rate_limit_bytes_blocked_total

# Tokens consumed by type
curl -s http://localhost:3000/ar-io/__gateway_metrics | grep rate_limit_tokens_consumed_total

# Paid tokens consumed (IP bucket)
curl -s http://localhost:3000/ar-io/__gateway_metrics | grep 'bucket_type="ip".*token_type="paid"'

# Regular tokens consumed (resource bucket)
curl -s http://localhost:3000/ar-io/__gateway_metrics | grep 'bucket_type="resource".*token_type="regular"'
```

#### Check Current Bucket State (Redis)

```bash
# List all rate limiter keys
redis-cli --scan --pattern "rl:*"

# Inspect specific bucket
redis-cli GET "rl:ip:192.168.1.100"

# Inspect bucket with paid tokens
redis-cli GET "rl:ip:192.168.1.100" | jq .paidTokens
```

#### Enable Debug Logging

```bash
# In environment configuration
LOG_LEVEL=debug

# View relevant logs
docker-compose logs -f core | grep -i "rate limit\|x402\|payment"
```

## Examples

### Example 1: Development Setup (Memory Limiter + Testnet)

**Use case**: Local development and testing

**What's different from Quick Start**:

- Explicitly sets `RATE_LIMITER_TYPE=memory` for single-node development
- Complete working example you can copy and run immediately

**.env file:**

```bash
# Rate limiter (memory-based, single node)
# Unlike Quick Start, explicitly sets TYPE=memory for development
ENABLE_RATE_LIMITER=true
RATE_LIMITER_TYPE=memory
RATE_LIMITER_IP_TOKENS_PER_BUCKET=100000
RATE_LIMITER_IP_REFILL_PER_SEC=20
RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET=1000000
RATE_LIMITER_RESOURCE_REFILL_PER_SEC=100

# x402 payments (testnet)
ENABLE_X_402_USDC_DATA_EGRESS=true
X_402_USDC_NETWORK=base-sepolia
X_402_USDC_WALLET_ADDRESS=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
X_402_USDC_FACILITATOR_URL=https://x402.org/facilitator
X_402_USDC_PER_BYTE_PRICE=0.0000000001
X_402_USDC_DATA_EGRESS_MIN_PRICE=0.001
X_402_USDC_DATA_EGRESS_MAX_PRICE=1.00

# Integration
X_402_RATE_LIMIT_CAPACITY_MULTIPLIER=10
```

**Testing:**

```bash
# Start gateway
docker-compose up -d

# Test rate limiting - after ~100 requests, you'll get 402 responses
for i in {1..200}; do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/TX_ID; done

# View the 402 payment response with requirements
curl -v http://localhost:3000/TX_ID

# Test payment in browser - visit http://localhost:3000/TX_ID
# After hitting rate limit, you'll see the paywall UI where you can pay
```

### Example 2: Production Setup (Redis Limiter + Mainnet)

**Use case**: Multi-node production deployment with real payments

**What's different from Quick Start**:

- Explicitly configures Redis endpoint (useful for external Redis)
- Adds Redis persistence to preserve paid tokens across restarts
- Includes paywall customization (app name and logo)
- Production-ready configuration with all recommended settings

**.env file:**

```bash
# Rate limiter (Redis-based, distributed)
# Explicitly configures Redis for production multi-node deployments
ENABLE_RATE_LIMITER=true
RATE_LIMITER_TYPE=redis
RATE_LIMITER_REDIS_ENDPOINT=redis://redis:6379
RATE_LIMITER_IP_TOKENS_PER_BUCKET=100000
RATE_LIMITER_IP_REFILL_PER_SEC=20
RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET=1000000
RATE_LIMITER_RESOURCE_REFILL_PER_SEC=100

# x402 payments (mainnet with Onramp integration)
ENABLE_X_402_USDC_DATA_EGRESS=true
X_402_USDC_NETWORK=base
X_402_USDC_WALLET_ADDRESS=0xYOUR_MAINNET_WALLET
X_402_USDC_FACILITATOR_URL=https://facilitator.x402.rs
X_402_CDP_CLIENT_KEY=YOUR_PUBLIC_CLIENT_KEY
CDP_API_KEY_SECRET_FILE=/app/secrets/cdp_secret_key
CDP_API_KEY_ID=YOUR_API_KEY_ID
X_402_USDC_PER_BYTE_PRICE=0.0000000001
X_402_USDC_DATA_EGRESS_MIN_PRICE=0.001
X_402_USDC_DATA_EGRESS_MAX_PRICE=1.00

# Integration
X_402_RATE_LIMIT_CAPACITY_MULTIPLIER=10

# Paywall customization (not in Quick Start)
X_402_APP_NAME=My AR.IO Gateway
X_402_APP_LOGO=https://example.com/logo.png

# Redis persistence - preserve paid tokens across restarts (CRITICAL for production)
# Hybrid approach: RDB snapshots + AOF for maximum durability
EXTRA_REDIS_FLAGS=--save 300 10 --appendonly yes --appendfsync everysec
```

**Security setup:**

```bash
# Create secrets directory with restricted permissions
mkdir -p ./secrets
chmod 700 ./secrets

# Store CDP secret key securely
echo "YOUR_CDP_SECRET_KEY" > ./secrets/cdp_secret_key
chmod 600 ./secrets/cdp_secret_key
```

### Example 3: Client-Side Payment Integration

**TypeScript/JavaScript client:**

```typescript
import { wrapFetchWithPayment } from 'x402-fetch';
import { privateKeyToAccount } from 'viem/accounts';

// Initialize wallet
const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
const account = privateKeyToAccount(privateKey);

// Wrap fetch with payment support
const fetchWithPayment = wrapFetchWithPayment(fetch, account);

// Function to download data with automatic payments
async function downloadData(txId: string): Promise<ArrayBuffer> {
  try {
    const response = await fetchWithPayment(
      `https://gateway.example.com/${txId}`,
      { method: 'GET' },
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check for payment response header
    const paymentResponse = response.headers.get('X-Payment-Response');
    if (paymentResponse) {
      console.log('Payment settled:', paymentResponse);
    }

    return await response.arrayBuffer();
  } catch (error) {
    console.error('Download failed:', error);
    throw error;
  }
}

// Usage
const data = await downloadData('YOUR_TX_ID');
console.log(`Downloaded ${data.byteLength} bytes`);
```

### Example 4: Monitoring Dashboard (Prometheus + Grafana)

**Prometheus queries:**

```promql
# Paid token consumption rate (per second)
rate(rate_limit_tokens_consumed_total{token_type="paid"}[5m])

# Regular token consumption rate
rate(rate_limit_tokens_consumed_total{token_type="regular"}[5m])

# Ratio of paid to regular tokens
sum(rate(rate_limit_tokens_consumed_total{token_type="paid"}[5m]))
/
sum(rate(rate_limit_tokens_consumed_total{token_type="regular"}[5m]))

# Top domains by token consumption
topk(10, sum by (domain) (rate(rate_limit_tokens_consumed_total[5m])))
```

**Grafana panels:**

1. **Token Consumption Over Time** (Graph)
   - Metric: `rate(rate_limit_tokens_consumed_total[5m])`
   - Legend: `{{bucket_type}} - {{token_type}}`

2. **Paid vs Regular Token Ratio** (Gauge)
   - Shows percentage of paid token usage

3. **Rate Limit Denials** (Counter)
   - Track 429 responses
   - Alert on high denial rates

4. **Payment Settlement Success** (Counter)
   - Track successful payments
   - Alert on settlement failures

---

## Additional Resources

- **x402 Protocol**: https://docs.cdp.coinbase.com/x402/
- **Coinbase Developer Platform**: https://portal.cdp.coinbase.com/
- **Base Network**: https://base.org/
- **AR.IO Documentation**: https://docs.ar.io/
- **Environment Variables Reference**: [docs/envs.md](envs.md)
- **Glossary**: [docs/glossary.md](glossary.md)
