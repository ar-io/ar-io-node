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

### How They Work Together

To use x402 payments, you must enable both features (`ENABLE_RATE_LIMITER=true`
and `ENABLE_X_402_USDC_DATA_EGRESS=true`). Here's how they integrate:

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

The x402 integration supports two Base blockchain networks:

| Feature                 | Base Sepolia (Testnet)            | Base (Mainnet)                    |
| ----------------------- | --------------------------------- | --------------------------------- |
| **USDC**                | Free testnet USDC (faucet)        | Real USDC (costs $$$)             |
| **CDP API Key**         | Not required                      | Required for official facilitator |
| **Default Facilitator** | https://x402.org/facilitator      | Must configure                    |
| **Use Case**            | Development, testing              | Production monetization           |
| **Configuration**       | `X_402_USDC_NETWORK=base-sepolia` | `X_402_USDC_NETWORK=base`         |

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

**Note:** x402 payments require the rate limiter to be enabled. There is no
"payments only" configuration.

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
# Through envoy (default port 3000)
curl http://localhost:3000/ar-io/__gateway_metrics | grep rate_limit_tokens_consumed_total

# Or directly to core (port 4000)
curl http://localhost:4000/ar-io/__gateway_metrics | grep rate_limit_tokens_consumed_total
```

### Quick Start: Rate Limiting with x402 Payments

**Important**: x402 requires the rate limiter to be enabled. Both features must
be configured together.

#### Testnet Setup (Development/Testing)

Use Base Sepolia testnet for development and testing:

**1. Prerequisites:**

- Ethereum wallet
- Testnet ETH from
  [Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
- Testnet USDC from [Circle's faucet](https://faucet.circle.com/)

**2. Add to `.env` file:**

```bash
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
# Set your test wallet private key
export X402_TEST_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

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
CDP_API_KEY_SECRET_FILE=/run/secrets/cdp_secret_key
CDP_API_KEY_ID=your_api_key_id

# Integration settings
X_402_RATE_LIMIT_CAPACITY_MULTIPLIER=10
```

**4. Security best practices:**

```bash
# Store CDP secret key with restricted permissions (if using Onramp)
echo "YOUR_CDP_SECRET_KEY" > /run/secrets/cdp_secret_key
chmod 600 /run/secrets/cdp_secret_key
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

#### Core Settings

**`ENABLE_RATE_LIMITER`** (boolean, default: `false`)

- Master switch for rate limiting
- When `false`, limits are tracked but not enforced (monitoring only)
- When `true`, requests are denied (429) when limits exceeded

**`RATE_LIMITER_TYPE`** (string, default: `redis`)

- Implementation to use: `memory` or `redis`
- `memory`: In-memory buckets (for development and testing only)
- `redis`: Redis-based buckets (recommended for all production deployments)
- Defaults to `redis` in `docker-compose.yaml` (reads from `.env` with fallback)

#### Bucket Capacity Configuration

**`RATE_LIMITER_IP_TOKENS_PER_BUCKET`** (number, default: `100000`)

- Maximum tokens in IP bucket
- 1 token = 1 KiB
- Default: ~98 MiB per IP
- Adjust based on expected user traffic patterns

**`RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET`** (number, default: `1000000`)

- Maximum tokens in resource bucket
- Default: ~976 MiB per resource
- Adjust based on content sizes

#### Refill Rate Configuration

**`RATE_LIMITER_IP_REFILL_PER_SEC`** (number, default: `20`)

- Tokens added per second to IP bucket
- Default: ~20 KiB/s sustained throughput per IP
- Lower values = more restrictive

**`RATE_LIMITER_RESOURCE_REFILL_PER_SEC`** (number, default: `100`)

- Tokens added per second to resource bucket
- Default: ~100 KiB/s sustained throughput per resource
- Higher values = more permissive

#### Redis Configuration

These settings have sensible defaults in `docker-compose.yaml` and rarely need
changes for standard deployments. Override in `.env` file only for custom Redis
setups.

**`RATE_LIMITER_REDIS_ENDPOINT`** (string, default: `redis://redis:6379`)

- Redis connection URL
- Only used when `RATE_LIMITER_TYPE=redis`

**`RATE_LIMITER_REDIS_USE_TLS`** (boolean, default: `false`)

- Enable TLS for Redis connection

**`RATE_LIMITER_REDIS_USE_CLUSTER`** (boolean, default: `false`)

- Use Redis cluster mode

#### Allowlist Configuration

**`RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST`** (comma-separated string, default:
`""`)

- IPs and CIDR ranges to exempt from rate limiting
- Example: `192.168.1.0/24,10.0.0.1,172.16.0.0/16`
- Allowlisted IPs skip all rate limit checks

**`RATE_LIMITER_ARNS_ALLOWLIST`** (comma-separated string, default: `""`)

- ArNS names to exempt from rate limiting and payment verification
- Example: `my-free-app,public-docs,community-resources`
- Useful for providing free access to specific content

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
- Persistent across restarts
- Scales horizontally
- Pre-configured in Docker Compose

**Cons:**

- Network latency (Redis calls)
- Requires Redis infrastructure
- Slightly more complex setup

**When to use:**

- **Recommended for all production deployments**

### Architecture

#### Integration with Data Handlers

The rate limiter integrates at the HTTP handler level:

```
Request → Rate Limit Check → Data Handler → Token Adjustment → Response
```

#### Metrics

The rate limiter exposes Prometheus metrics at `/ar-io/__gateway_metrics`:

**`rate_limit_tokens_consumed_total`** (counter)

- Total tokens consumed
- Labels:
  - `bucket_type`: `ip` or `resource`
  - `token_type`: `paid` or `regular`
  - `domain`: Request domain/host

Example PromQL query:

```promql
# Paid tokens consumed per IP
rate(rate_limit_tokens_consumed_total{bucket_type="ip",token_type="paid"}[5m])

# Regular tokens consumed per resource
rate(rate_limit_tokens_consumed_total{bucket_type="resource",token_type="regular"}[5m])
```

## x402 Payment Protocol Deep Dive

**⚠️ IMPORTANT**: x402 **requires** the rate limiter to be enabled
(`ENABLE_RATE_LIMITER=true`). The payment protocol is not a standalone feature -
it is an extension of the rate limiting system. 402 Payment Required responses
are only sent when rate limits are exceeded. Without the rate limiter, x402
payments will not function.

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

**Available facilitators:**

| Facilitator       | URL                               | Networks           | Auth Required | Notes                    |
| ----------------- | --------------------------------- | ------------------ | ------------- | ------------------------ |
| Coinbase Official | https://x402.org/facilitator      | base-sepolia       | No            | Default for testnet      |
| x402.rs           | https://facilitator.x402.rs       | base, base-sepolia | No            | No authentication needed |
| payai.network     | https://facilitator.payai.network | base, base-sepolia | Varies        | Check facilitator docs   |

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
X_402_CDP_CLIENT_KEY_FILE=/run/secrets/cdp_client_key
```

**Setup with alternative facilitator:**

```bash
X_402_USDC_NETWORK=base
X_402_USDC_FACILITATOR_URL=https://facilitator.x402.rs
# No CDP key needed
```

### Configuration Reference

#### Core Settings

**`ENABLE_X_402_USDC_DATA_EGRESS`** (boolean, default: `false`)

- Master switch for x402 payments
- When `false`, payment headers ignored
- When `true`, payments accepted and verified

**`X_402_USDC_NETWORK`** (string, default: `base-sepolia`)

- Blockchain network to use
- Options: `base` (mainnet) or `base-sepolia` (testnet)
- Must match your wallet and USDC holdings

**`X_402_USDC_WALLET_ADDRESS`** (hex string, required if enabled)

- Ethereum wallet address to receive payments
- Format: `0x...` (42 characters)
- Must be a valid Ethereum address

**`X_402_USDC_FACILITATOR_URL`** (URL, default: `https://x402.org/facilitator`)

- Facilitator endpoint for verification and settlement
- Must include protocol (`https://`)

#### Pricing Configuration

**`X_402_USDC_PER_BYTE_PRICE`** (number, default: `0.0000000001`)

- Price in USDC per byte of data egress
- Default: $0.10 per GB
- Examples:
  - $0.10/GB = `0.0000000001`
  - $0.50/GB = `0.0000000005`
  - $1.00/GB = `0.000000001`

**`X_402_USDC_DATA_EGRESS_MIN_PRICE`** (number, default: `0.001`)

- Minimum price in USDC per request
- Used when content length unknown
- Prevents free access to small files

**`X_402_USDC_DATA_EGRESS_MAX_PRICE`** (number, default: `1.00`)

- Maximum price in USDC per request
- Caps cost for very large files
- Protects users from unexpected charges

**Price calculation:**

```javascript
const priceUSD = contentLength * perBytePrice;
const clampedPrice = Math.min(Math.max(priceUSD, minPrice), maxPrice);
```

#### CDP API Key Configuration (Onramp Integration)

These keys are required for mainnet deployments when using Coinbase
facilitators. They enable Coinbase Onramp integration for easy USDC purchases in
the browser paywall. Optional for testnet only.

**`X_402_CDP_CLIENT_KEY`** (string, **PUBLIC** - safe for client-side)

- Coinbase Developer Platform public client API key
- Used in browser paywall for Onramp widget
- Safe to expose in client-side code

**`CDP_API_KEY_ID`** (string, **SENSITIVE SECRET**)

- Coinbase Developer Platform secret API key ID
- Used server-side for Onramp session token generation
- **Never commit to git or expose in logs**

**`CDP_API_KEY_SECRET`** (string, **SENSITIVE SECRET**)

- Coinbase Developer Platform secret API key secret
- Used server-side for Onramp session token generation
- **Never commit to git or expose in logs**

**`CDP_API_KEY_SECRET_FILE`** (file path, **SENSITIVE SECRET**)

- Path to file containing CDP API secret
- **Takes precedence over `CDP_API_KEY_SECRET` if set**
- Recommended approach for production
- **Restrict file permissions**: `chmod 600`

**Security requirements for secret keys:**

- Store in secrets manager (AWS Secrets Manager, HashiCorp Vault, etc.)
- Use file-based config with restricted permissions
- Never expose in logs or error messages
- Apply principle of least privilege

#### Settlement Configuration

**`X_402_USDC_SETTLE_TIMEOUT_MS`** (number, default: `5000`)

- Timeout in milliseconds for settlement operations
- Prevents indefinite hanging on facilitator issues
- Adjust based on facilitator performance

#### Paywall Customization

**`X_402_APP_NAME`** (string, default: `"AR.IO Gateway"`)

- Application name displayed in browser paywall UI

**`X_402_APP_LOGO`** (URL, optional)

- URL to application logo for paywall UI
- Recommended: square image, 200x200px or larger

**`X_402_SESSION_TOKEN_ENDPOINT`** (URL, optional)

- Custom session token endpoint for payment authentication
- Advanced use cases only

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
CDP_API_KEY_SECRET_FILE=/run/secrets/cdp_secret_key
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
  echo "YOUR_SECRET_KEY" > /run/secrets/cdp_secret_key
  chmod 600 /run/secrets/cdp_secret_key
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
  ls -l /run/secrets/cdp_secret_key
  cat /run/secrets/cdp_secret_key
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

#### View Token Consumption Metrics

```bash
# Total tokens consumed by type
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

**docker-compose.override.yml:**

```yaml
services:
  core:
    environment:
      # Rate limiter (memory-based, single node)
      - ENABLE_RATE_LIMITER=true
      - RATE_LIMITER_TYPE=memory
      - RATE_LIMITER_IP_TOKENS_PER_BUCKET=100000
      - RATE_LIMITER_IP_REFILL_PER_SEC=20
      - RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET=1000000
      - RATE_LIMITER_RESOURCE_REFILL_PER_SEC=100

      # x402 payments (testnet)
      - ENABLE_X_402_USDC_DATA_EGRESS=true
      - X_402_USDC_NETWORK=base-sepolia
      - X_402_USDC_WALLET_ADDRESS=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
      - X_402_USDC_FACILITATOR_URL=https://x402.org/facilitator
      - X_402_USDC_PER_BYTE_PRICE=0.0000000001
      - X_402_USDC_DATA_EGRESS_MIN_PRICE=0.001
      - X_402_USDC_DATA_EGRESS_MAX_PRICE=1.00

      # Integration
      - X_402_RATE_LIMIT_CAPACITY_MULTIPLIER=10
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

**docker-compose.override.yml:**

```yaml
services:
  core:
    environment:
      # Rate limiter (Redis-based, distributed)
      - ENABLE_RATE_LIMITER=true
      - RATE_LIMITER_TYPE=redis
      - RATE_LIMITER_REDIS_ENDPOINT=redis://redis:6379
      - RATE_LIMITER_IP_TOKENS_PER_BUCKET=100000
      - RATE_LIMITER_IP_REFILL_PER_SEC=20
      - RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET=1000000
      - RATE_LIMITER_RESOURCE_REFILL_PER_SEC=100

      # x402 payments (mainnet with Onramp integration)
      - ENABLE_X_402_USDC_DATA_EGRESS=true
      - X_402_USDC_NETWORK=base
      - X_402_USDC_WALLET_ADDRESS=0xYOUR_MAINNET_WALLET
      - X_402_USDC_FACILITATOR_URL=https://facilitator.x402.rs
      - X_402_CDP_CLIENT_KEY=YOUR_PUBLIC_CLIENT_KEY
      - CDP_API_KEY_SECRET_FILE=/run/secrets/cdp_secret_key
      - CDP_API_KEY_ID=YOUR_API_KEY_ID
      - X_402_USDC_PER_BYTE_PRICE=0.0000000001
      - X_402_USDC_DATA_EGRESS_MIN_PRICE=0.001
      - X_402_USDC_DATA_EGRESS_MAX_PRICE=1.00

      # Integration
      - X_402_RATE_LIMIT_CAPACITY_MULTIPLIER=10

      # Paywall customization
      - X_402_APP_NAME=My AR.IO Gateway
      - X_402_APP_LOGO=https://example.com/logo.png

    volumes:
      - /run/secrets/cdp_secret_key:/run/secrets/cdp_secret_key:ro
```

**Security setup:**

```bash
# Create secrets directory with restricted permissions
sudo mkdir -p /run/secrets
sudo chmod 700 /run/secrets

# Store CDP secret key securely
echo "YOUR_CDP_SECRET_KEY" | sudo tee /run/secrets/cdp_secret_key > /dev/null
sudo chmod 600 /run/secrets/cdp_secret_key
sudo chown root:root /run/secrets/cdp_secret_key
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
