# Gateway Auth Service - Proposed Architecture

## For Developer Implementation

**Date**: 2026-02-13
**Status**: Ready for Development

---

## Executive Summary

Build gateway authentication by **extending Turbo Payment Services** (for auth, API keys, billing) and adding a **thin proxy sidecar** (for fast validation and proxying) deployed alongside each gateway.

### Architecture Decision: Extend Turbo + Thin Proxy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EXISTING CODEBASES                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐         │
│  │   ar.io Console │    │ Turbo Payment   │    │   ar-io-node    │         │
│  │    (Frontend)   │    │    Services     │    │    (Gateway)    │         │
│  │                 │    │     (AWS)       │    │                 │         │
│  │  Hosted on      │    │                 │    │  Serves Arweave │         │
│  │  Arweave        │    │  - Wallet auth  │    │  data           │         │
│  │                 │    │  - Payments     │    │                 │         │
│  │                 │    │  - Credits      │    │                 │         │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘         │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                              WHAT WE'RE ADDING                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐                           ┌─────────────────┐         │
│  │ Turbo Payment   │                           │   Thin Proxy    │         │
│  │   (EXTEND)      │◄─────── sync keys ───────►│   (NEW)         │         │
│  │                 │                           │                 │         │
│  │  + API key CRUD │                           │  - Validate key │         │
│  │  + Key storage  │                           │  - Rate limit   │         │
│  │  + Usage billing│◄─────── usage data ───────│  - Proxy req    │         │
│  │  + Gateway quota│                           │  - Count bytes  │         │
│  └─────────────────┘                           └─────────────────┘         │
│        (AWS)                                    (with ar-io-node)          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why This Architecture?

| Factor | Decision |
|--------|----------|
| **Turbo already has wallet auth** | Reuse ANS-104 verification, don't rebuild |
| **Turbo already has user/wallet DB** | Single source of truth for identity |
| **Turbo already has billing** | Unified credits for uploads + gateway |
| **Turbo is in AWS** | API key management stays there, sync to edge |
| **Gateway needs low latency** | Thin proxy deployed locally, caches keys |
| **Console already talks to Turbo** | Add gateway section to existing UI |

### Component Responsibilities

| Component | Location | Responsibility |
|-----------|----------|----------------|
| **Turbo Payment Services** | AWS | Auth (ANS-104), API key CRUD, usage billing, quotas |
| **Thin Proxy** | With each gateway | Key validation (cached), rate limiting, proxying, byte counting |
| **ar.io Console** | Arweave | Dashboard UI - talks to Turbo for everything |
| **ar-io-node** | Customer infra | Gateway - unchanged, receives proxied requests |

---

## Part 1: Turbo Payment Services Extensions

### What to Add to Turbo

```
turbo-payment-services/
├── existing/
│   ├── wallet-auth/          # ANS-104 signature verification
│   ├── users/                # User/wallet database
│   ├── payments/             # Credit purchases
│   └── balances/             # Credit balances
│
└── NEW: gateway/
    ├── api-keys/             # CRUD for gateway API keys
    │   ├── create            # Generate key, store hash
    │   ├── list              # List user's keys
    │   ├── revoke            # Disable key
    │   └── rotate            # Create new, revoke old
    │
    ├── key-restrictions/     # Security settings
    │   ├── allowed-origins   # For browser keys
    │   └── allowed-ips       # For server keys
    │
    ├── usage/                # Usage tracking
    │   ├── ingest            # Receive usage from proxies
    │   ├── aggregate         # Daily/monthly rollups
    │   └── query             # Usage API for console
    │
    └── sync/                 # Key sync for proxies
        └── keys              # Endpoint for proxy to fetch keys
```

### New API Endpoints (in Turbo)

```
# API Keys (authenticated via existing Turbo auth)
GET    /v1/gateway/keys                # List my keys
POST   /v1/gateway/keys                # Create key
DELETE /v1/gateway/keys/:id            # Revoke key

# Key restrictions
GET    /v1/gateway/keys/:id/origins    # List origins
POST   /v1/gateway/keys/:id/origins    # Add origin
DELETE /v1/gateway/keys/:id/origins/:oid

GET    /v1/gateway/keys/:id/ips        # List IPs
POST   /v1/gateway/keys/:id/ips        # Add IP
DELETE /v1/gateway/keys/:id/ips/:iid

# Usage (for console dashboard)
GET    /v1/gateway/usage               # Current period
GET    /v1/gateway/usage/history       # Daily breakdown

# For thin proxy (internal/authenticated)
GET    /internal/gateway/keys/sync     # Get all active keys for caching
POST   /internal/gateway/usage/ingest  # Batch usage data from proxy
```

### New Database Tables (in Turbo's DB)

```sql
-- Wallets (users identified by wallet address)
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Wallet identity
    address VARCHAR(255) NOT NULL,           -- Wallet address (Arweave/ETH/Solana)
    chain VARCHAR(20) NOT NULL,              -- 'arweave', 'ethereum', 'solana'

    -- Profile (optional, can be empty)
    display_name VARCHAR(255),

    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,

    UNIQUE(address, chain)
);

-- Auth challenges (for replay protection)
CREATE TABLE auth_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(255) NOT NULL,
    nonce VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,         -- Short-lived (5 min)
    used_at TIMESTAMPTZ,                      -- NULL until used
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Organizations (1 per wallet for now, supports multi later)
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    owner_wallet_id UUID REFERENCES wallets(id),

    -- Quotas
    monthly_request_limit BIGINT DEFAULT 100000,
    monthly_egress_limit BIGINT DEFAULT 1073741824, -- 1GB
    rate_limit_rps INT DEFAULT 10,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- API Keys
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    created_by_wallet_id UUID REFERENCES wallets(id),

    name VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL,         -- "ario_prod_xxxx"
    key_hash VARCHAR(255) NOT NULL,          -- argon2 hash

    -- Key type determines security model
    key_type VARCHAR(20) DEFAULT 'server',   -- 'server' or 'browser'

    -- Route scopes (what the key can access)
    -- '*' = all, or specific: ['data:read', 'graphql', 'arns:resolve']
    scopes TEXT[] DEFAULT ARRAY['*'],

    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,                   -- NULL = never

    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- IP Allowlist for Server Keys (optional extra security)
-- If a server key has entries here, requests MUST come from these IPs
CREATE TABLE api_key_allowed_ips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id) ON DELETE CASCADE,

    -- Can be single IP or CIDR: '192.168.1.1', '10.0.0.0/8'
    ip_pattern VARCHAR(50) NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(api_key_id, ip_pattern)
);

-- Allowed Origins for Browser Keys (Domain Restrictions)
-- If a key has entries here, requests MUST come from matching origins
CREATE TABLE api_key_allowed_origins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id) ON DELETE CASCADE,

    -- Pattern can be exact or wildcard: 'myapp.com', '*.myapp.com', 'localhost:3000'
    pattern VARCHAR(255) NOT NULL,

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(api_key_id, pattern)
);

-- Usage (daily aggregates)
CREATE TABLE usage_daily (
    id BIGSERIAL PRIMARY KEY,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,

    date DATE NOT NULL,
    request_count BIGINT DEFAULT 0,
    bytes_egress BIGINT DEFAULT 0,

    UNIQUE(org_id, api_key_id, date)
);

-- Recent Request Logs (for debugging - like QuickNode's request explorer)
-- Stores last N requests per org for debugging/troubleshooting
CREATE TABLE request_logs (
    id BIGSERIAL PRIMARY KEY,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,

    -- Request details
    method VARCHAR(10) NOT NULL,             -- GET, POST, etc.
    path VARCHAR(500) NOT NULL,              -- /raw/TX_ID, /graphql, etc.
    status_code INT NOT NULL,                -- 200, 401, 429, etc.

    -- Timing
    request_at TIMESTAMPTZ DEFAULT NOW(),
    duration_ms INT,                         -- Response time

    -- Size
    request_bytes INT DEFAULT 0,
    response_bytes INT DEFAULT 0,

    -- Client info (for debugging)
    origin VARCHAR(255),                     -- Origin header
    user_agent VARCHAR(500),
    client_ip VARCHAR(50),

    -- Error info (if applicable)
    error_code VARCHAR(50),                  -- RATE_LIMIT_EXCEEDED, etc.

    -- Auto-cleanup: Only keep last 7 days
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient recent request queries
CREATE INDEX idx_request_logs_org_recent ON request_logs(org_id, request_at DESC);
-- Auto-cleanup old logs (run daily cron)
-- DELETE FROM request_logs WHERE created_at < NOW() - INTERVAL '7 days';

-- Indexes
CREATE INDEX idx_wallets_address ON wallets(address, chain);
CREATE INDEX idx_auth_challenges_wallet ON auth_challenges(wallet_address)
    WHERE used_at IS NULL AND expires_at > NOW();
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix) WHERE is_active = TRUE;
CREATE INDEX idx_api_key_allowed_origins ON api_key_allowed_origins(api_key_id);
CREATE INDEX idx_api_key_allowed_ips ON api_key_allowed_ips(api_key_id);
CREATE INDEX idx_usage_daily_org_date ON usage_daily(org_id, date);
```

---

## Part 2: Thin Proxy (New Codebase)

The thin proxy is a **small, focused service** deployed alongside each ar-io-node gateway. It's the only new codebase needed.

### What It Does (and Doesn't Do)

| Does | Doesn't Do |
|------|------------|
| Validate API keys (cached) | Store API keys (Turbo does) |
| Check rate limits | Manage users (Turbo does) |
| Check origin/IP restrictions | Handle auth (Turbo does) |
| Proxy requests to gateway | Aggregate billing (Turbo does) |
| Count bytes transferred | |
| Report usage to Turbo (async) | |

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Developer's App                                    │
│                                                                              │
│    fetch('https://gateway.example.com/v1/raw/TX_ID', {                      │
│      headers: { 'X-API-Key': 'ario_prod_xxxx' }                             │
│    })                                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Thin Proxy                                        │
│                        (Node.js / ~500 lines)                                │
│                                                                              │
│   1. Extract X-API-Key header                                               │
│   2. Check Redis cache for key data                                         │
│      └─> Cache miss? Fetch from Turbo, cache for 5 min                      │
│   3. Validate: origin, IP, scopes, expiration                               │
│   4. Check rate limit (Redis sliding window)                                │
│   5. Proxy request to ar-io-node                                            │
│   6. Stream response, count bytes                                           │
│   7. Record usage in Redis (async)                                          │
│   8. Batch send usage to Turbo every 60 seconds                             │
│                                                                              │
│   ┌──────────────┐                                                          │
│   │    Redis     │  - API key cache (from Turbo)                            │
│   │   (local)    │  - Rate limit counters                                   │
│   │              │  - Usage counters (pending sync)                         │
│   └──────────────┘                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ar-io-node                                         │
│                      http://localhost:3000                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Thin Proxy Code Structure

```
gateway-proxy/                    # New repo, small and focused
├── src/
│   ├── index.ts                 # Fastify server entry
│   ├── proxy.ts                 # Proxy handler (~100 lines)
│   ├── auth.ts                  # Key validation (~50 lines)
│   ├── rate-limit.ts            # Redis rate limiting (~50 lines)
│   ├── usage.ts                 # Usage tracking + Turbo sync (~100 lines)
│   └── config.ts                # Environment config
├── Dockerfile
├── docker-compose.yml           # Proxy + Redis
├── package.json
└── README.md
```

### Thin Proxy Pseudocode

```typescript
// ~200 lines total for the core logic

import Fastify from 'fastify';
import { createClient } from 'redis';
import { request } from 'undici';

const redis = createClient({ url: process.env.REDIS_URL });
const TURBO_URL = process.env.TURBO_URL;
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const KEY_CACHE_TTL = 300; // 5 minutes

// Main proxy handler
async function proxyHandler(req, res) {
  const startTime = Date.now();

  // 1. Get API key
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).send({ error: 'Missing API key' });
  }

  // 2. Validate key (cache first, then Turbo)
  const keyData = await getKeyData(apiKey);
  if (!keyData || !keyData.active) {
    return res.status(401).send({ error: 'Invalid API key' });
  }

  // 3. Security checks
  if (!checkOrigin(req, keyData)) {
    return res.status(403).send({ error: 'Origin not allowed' });
  }
  if (!checkIP(req, keyData)) {
    return res.status(403).send({ error: 'IP not allowed' });
  }
  if (!checkScope(req.url, keyData)) {
    return res.status(403).send({ error: 'Route not allowed' });
  }

  // 4. Rate limit
  const rateLimitOk = await checkRateLimit(keyData.orgId);
  if (!rateLimitOk) {
    return res.status(429).send({ error: 'Rate limit exceeded' });
  }

  // 5. Proxy to gateway
  const targetUrl = GATEWAY_URL + req.url.replace(/^\/v1/, '');
  const response = await request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: undefined },
    body: req.body,
  });

  // 6. Stream response, count bytes
  let bytes = 0;
  res.status(response.statusCode);
  for await (const chunk of response.body) {
    bytes += chunk.length;
    res.raw.write(chunk);
  }
  res.raw.end();

  // 7. Record usage (async, don't block)
  recordUsage(keyData.orgId, keyData.keyId, bytes, Date.now() - startTime);
}

// Key validation with caching
async function getKeyData(apiKey: string) {
  const prefix = apiKey.slice(0, 16);
  const cacheKey = `key:${prefix}`;

  // Check cache
  let keyData = await redis.get(cacheKey);
  if (keyData) return JSON.parse(keyData);

  // Fetch from Turbo
  const response = await request(`${TURBO_URL}/internal/gateway/keys/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: apiKey }),
  });

  if (response.statusCode !== 200) return null;

  keyData = await response.body.json();
  await redis.setEx(cacheKey, KEY_CACHE_TTL, JSON.stringify(keyData));
  return keyData;
}

// Usage batching - send to Turbo every 60 seconds
setInterval(async () => {
  const pending = await redis.hGetAll('usage:pending');
  if (Object.keys(pending).length === 0) return;

  await request(`${TURBO_URL}/internal/gateway/usage/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usage: pending }),
  });

  await redis.del('usage:pending');
}, 60_000);
```

### Thin Proxy Environment Variables

```bash
# Required
GATEWAY_URL=http://localhost:3000    # ar-io-node
TURBO_URL=https://payment.ardrive.io # Turbo payment services
REDIS_URL=redis://localhost:6379
TURBO_INTERNAL_KEY=<secret>          # For internal API auth

# Optional
PORT=4000
KEY_CACHE_TTL=300                    # 5 minutes
USAGE_SYNC_INTERVAL=60000            # 1 minute
RATE_LIMIT_WINDOW=1000               # 1 second
```

### Deployment

```yaml
# docker-compose.yml (runs alongside ar-io-node)
version: '3.8'
services:
  proxy:
    image: ghcr.io/ar-io/gateway-proxy:latest
    ports:
      - "4000:4000"
    environment:
      - GATEWAY_URL=http://gateway:3000
      - TURBO_URL=https://payment.ardrive.io
      - REDIS_URL=redis://redis:6379
      - TURBO_INTERNAL_KEY=${TURBO_INTERNAL_KEY}
    depends_on:
      - redis
      - gateway

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

  gateway:
    image: ghcr.io/ar-io/ar-io-node:latest
    # ... existing ar-io-node config

volumes:
  redis_data:
```

---

## Part 3: Console Integration

The ar.io console talks to **Turbo** (not the proxy) for all management operations.

### API Endpoints (All in Turbo)

```
# Wallet Authentication
GET    /auth/challenge         # Get challenge to sign
       ?wallet=<address>       # Query param: wallet address
       &chain=arweave          # Query param: arweave|ethereum|solana

POST   /auth/verify            # Verify signature, get JWT
       {
         wallet: "<address>",
         chain: "arweave",
         signature: "<sig>",
         message: "<challenge>"
       }

POST   /auth/logout            # Invalidate JWT (optional)

GET    /auth/me                # Get current user info

# API Keys
GET    /keys                   # List my keys
POST   /keys                   # Create key (returns secret ONCE)
       {
         name: "My App",
         type: "browser",                    # 'server' (default) or 'browser'
         scopes: ["data:read", "graphql"],   # Route scopes (default: ['*'])
         allowed_origins: [                  # For browser keys
           "myapp.com",
           "*.myapp.com",
           "localhost:3000"
         ],
         allowed_ips: [                      # For server keys (optional)
           "192.168.1.0/24",
           "10.0.0.5"
         ]
       }

DELETE /keys/:id               # Revoke key

# Allowed Origins (for browser keys)
GET    /keys/:id/origins       # List allowed origins for a key
POST   /keys/:id/origins       # Add allowed origin
       { pattern: "newdomain.com" }
DELETE /keys/:id/origins/:oid  # Remove allowed origin

# Allowed IPs (for server keys)
GET    /keys/:id/ips           # List allowed IPs for a key
POST   /keys/:id/ips           # Add allowed IP
       { pattern: "10.0.0.0/8" }
DELETE /keys/:id/ips/:iid      # Remove allowed IP

# Usage
GET    /usage                  # Get current period usage
GET    /usage/history          # Get daily breakdown

# Request Logs (for debugging - like QuickNode's request explorer)
GET    /requests               # Get recent requests (last 100)
       ?key_id=<uuid>          # Filter by API key (optional)
       ?status=4xx             # Filter by status (optional: 2xx, 4xx, 5xx)
       ?limit=50               # Number of results (default 100, max 500)

# Gateway Proxy (the main event)
ALL    /v1/*                   # Proxy to gateway with API key auth
       Header: X-API-Key: ario_prod_xxxxx
```

### Request Flow (Detailed)

```typescript
// Pseudocode for wallet auth

async function getChallengeHandler(req, res) {
    const { wallet, chain } = req.query;

    // Generate random nonce
    const nonce = crypto.randomBytes(32).toString('hex');
    const timestamp = Date.now();
    const message = `Sign this message to authenticate with AR.IO Gateway:\n\nNonce: ${nonce}\nTimestamp: ${timestamp}`;

    // Store challenge (expires in 5 minutes)
    await db.authChallenges.create({
        wallet_address: wallet,
        nonce,
        expires_at: new Date(Date.now() + 5 * 60 * 1000)
    });

    return res.json({ message, nonce, expires_in: 300 });
}

async function verifyHandler(req, res) {
    const { wallet, chain, signature, message } = req.body;

    // 1. Extract nonce from message and verify it exists/not expired
    const challenge = await db.authChallenges.findValid(wallet, message);
    if (!challenge) {
        return res.status(401).json({ error: 'Invalid or expired challenge' });
    }

    // 2. Verify signature based on chain (REUSE TURBO'S CODE HERE)
    const isValid = await verifyWalletSignature(chain, wallet, message, signature);
    if (!isValid) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // 3. Mark challenge as used (prevent replay)
    await db.authChallenges.markUsed(challenge.id);

    // 4. Get or create wallet/user
    let walletRecord = await db.wallets.findByAddress(wallet, chain);
    if (!walletRecord) {
        walletRecord = await db.wallets.create({ address: wallet, chain });
        // Auto-create personal org for new users
        await db.organizations.create({
            name: `${wallet.slice(0, 8)}...`,
            owner_wallet_id: walletRecord.id
        });
    }

    // 5. Issue JWT
    const token = await signJwt({
        sub: walletRecord.id,
        wallet: wallet,
        chain: chain
    }, { expiresIn: '7d' });

    return res.json({ token, wallet: walletRecord });
}

// Pseudocode for main proxy handler (full security + logging)

async function proxyHandler(req, res) {
    const startTime = Date.now();
    let statusCode = 200;
    let errorCode = null;

    try {
        // 1. Extract API key
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            statusCode = 401; errorCode = 'MISSING_API_KEY';
            return res.status(401).json({ error: 'Missing API key' });
        }

        // 2. Validate key (cache lookup first, then DB)
        const keyData = await validateApiKey(apiKey);
        if (!keyData) {
            statusCode = 401; errorCode = 'INVALID_API_KEY';
            return res.status(401).json({ error: 'Invalid API key' });
        }
        if (keyData.expired) {
            statusCode = 401; errorCode = 'EXPIRED_API_KEY';
            return res.status(401).json({ error: 'API key expired' });
        }

        // 3. Validate origin for BROWSER keys
        if (keyData.type === 'browser' && keyData.allowedOrigins.length > 0) {
            const origin = req.headers['origin'] || req.headers['referer'];
            if (!origin) {
                statusCode = 403; errorCode = 'ORIGIN_REQUIRED';
                return res.status(403).json({ error: 'Origin header required for browser keys' });
            }
            if (!isOriginAllowed(origin, keyData.allowedOrigins)) {
                statusCode = 403; errorCode = 'ORIGIN_NOT_ALLOWED';
                return res.status(403).json({ error: 'Origin not allowed', origin });
            }
        }

        // 4. Validate IP for SERVER keys (if allowlist configured)
        if (keyData.type === 'server' && keyData.allowedIps.length > 0) {
            const clientIp = getClientIp(req);
            if (!isIpAllowed(clientIp, keyData.allowedIps)) {
                statusCode = 403; errorCode = 'IP_NOT_ALLOWED';
                return res.status(403).json({ error: 'IP not allowed', ip: clientIp });
            }
        }

        // 5. Check route scopes
        const routeScope = getRouteScope(req.url);  // e.g., 'data:read', 'graphql'
        if (!keyData.scopes.includes('*') && !keyData.scopes.includes(routeScope)) {
            statusCode = 403; errorCode = 'SCOPE_NOT_ALLOWED';
            return res.status(403).json({
                error: 'API key does not have permission for this route',
                required_scope: routeScope,
                key_scopes: keyData.scopes
            });
        }

        // 6. Check rate limit
        const rateLimitOk = await checkRateLimit(keyData.orgId, keyData.rateLimit);
        if (!rateLimitOk) {
            statusCode = 429; errorCode = 'RATE_LIMIT_EXCEEDED';
            return res.status(429).json({
                error: 'Rate limit exceeded',
                retry_after: rateLimitOk.retryAfter
            });
        }

        // 7. Check quota (soft limit - warn but allow)
        const quota = await checkQuota(keyData.orgId);
        if (quota.exceeded) {
            res.setHeader('X-Quota-Exceeded', 'true');
        }

        // 8. Add CORS headers for browser requests
        const origin = req.headers['origin'];
        if (origin && keyData.type === 'browser') {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
            res.setHeader('Access-Control-Max-Age', '86400');
        }

        // 9. Proxy to gateway
        const gatewayUrl = process.env.GATEWAY_URL + req.url.replace('/v1', '');
        const response = await proxy(gatewayUrl, req);
        statusCode = response.statusCode;

        // 10. Stream response and count bytes
        let bytesTransferred = 0;
        response.body.on('data', chunk => bytesTransferred += chunk.length);

        // 11. Record usage + request log (async, don't block response)
        response.body.on('end', () => {
            const duration = Date.now() - startTime;
            recordUsage(keyData.orgId, keyData.id, bytesTransferred).catch(log.error);
            logRequest(keyData, req, statusCode, duration, bytesTransferred, errorCode).catch(log.error);
        });

        return response.pipe(res);

    } finally {
        // Always log the request, even on errors
        if (errorCode) {
            const duration = Date.now() - startTime;
            logRequest(null, req, statusCode, duration, 0, errorCode).catch(log.error);
        }
    }
}

// Handle CORS preflight for browser keys
async function corsPreflightHandler(req, res) {
    const origin = req.headers['origin'];
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
        res.setHeader('Access-Control-Max-Age', '86400');
    }
    return res.status(204).end();
}

// Origin matching utility
function isOriginAllowed(origin: string, patterns: string[]): boolean {
    const originHost = new URL(origin).host;

    for (const pattern of patterns) {
        if (pattern.startsWith('*.')) {
            // Wildcard match: *.example.com matches sub.example.com
            const suffix = pattern.slice(1); // .example.com
            if (originHost.endsWith(suffix) || originHost === pattern.slice(2)) {
                return true;
            }
        } else if (originHost === pattern) {
            // Exact match
            return true;
        }
    }
    return false;
}
```

### Redis Keys

```
# Rate limiting (sliding window)
ratelimit:{org_id}:count     # Current window count
ratelimit:{org_id}:reset     # Window reset timestamp

# Usage counters (current month)
usage:{org_id}:requests      # Request count
usage:{org_id}:bytes         # Bytes transferred

# API key cache (avoid DB lookup on every request)
apikey:{key_prefix}          # JSON: { orgId, keyHash, rateLimit, expires, type, scopes, allowedOrigins, allowedIps }

# JWT sessions (optional - for logout/revocation)
session:{wallet_id}:{jti}    # Exists if session valid, TTL matches JWT exp
```

### Environment Variables

```bash
# Required
DATABASE_URL=postgresql://gas:pass@localhost:5432/gas
REDIS_URL=redis://localhost:6379
GATEWAY_URL=http://localhost:3000  # ar-io-node
JWT_SECRET=<random-64-chars>       # For signing JWTs

# Optional
PORT=4000
LOG_LEVEL=info
API_KEY_CACHE_TTL=300              # 5 minutes
RATE_LIMIT_WINDOW=1000             # 1 second
CHALLENGE_EXPIRY=300               # 5 minutes for auth challenges
JWT_EXPIRY=604800                  # 7 days
```

---

## What To Build (Ordered)

Two parallel workstreams - can be done by different developers:

### Workstream A: Turbo Extensions (AWS)

#### Week 1: API Key Management

- [ ] Database migrations (api_keys, origins, ips tables)
- [ ] API key CRUD endpoints (`/v1/gateway/keys/*`)
- [ ] Key generation with argon2 hashing
- [ ] Origin/IP restriction endpoints
- [ ] Route scopes on keys
- [ ] Auto-create first key on new user (if no gateway keys exist)

**Milestone**: Users can create/manage API keys via Turbo API

#### Week 2: Usage & Sync

- [ ] Internal key sync endpoint (`/internal/gateway/keys/sync`)
- [ ] Internal key validation endpoint (`/internal/gateway/keys/validate`)
- [ ] Usage ingestion endpoint (`/internal/gateway/usage/ingest`)
- [ ] Usage aggregation (daily rollups)
- [ ] Usage query endpoints for console (`/v1/gateway/usage/*`)
- [ ] Request logs storage + query

**Milestone**: Proxy can sync keys and report usage

### Workstream B: Thin Proxy (New Repo)

#### Week 1: Core Proxy

- [ ] Project setup (Fastify, TypeScript, minimal deps)
- [ ] Key validation with Redis caching
- [ ] Fetch keys from Turbo on cache miss
- [ ] Origin validation for browser keys
- [ ] IP validation for server keys
- [ ] Scope validation
- [ ] Rate limiting (Redis sliding window)
- [ ] Proxy handler with streaming

**Milestone**: Proxy validates keys and proxies to gateway

#### Week 2: Usage & Polish

- [ ] Byte counting on responses
- [ ] Usage recording to Redis
- [ ] Batch usage sync to Turbo (every 60s)
- [ ] Docker compose setup
- [ ] Health check endpoint
- [ ] Prometheus metrics
- [ ] Error handling polish

**Milestone**: Full usage tracking, ready for deployment

### Week 3: Integration & Testing

- [ ] Deploy proxy alongside test gateway
- [ ] End-to-end testing (console → Turbo → proxy → gateway)
- [ ] Console UI updates for gateway section
- [ ] Documentation
- [ ] Test with initial customer

**Milestone**: Ready for customer pilot

---

## What NOT To Build

| Feature | Why | When to Add |
|---------|-----|-------------|
| Separate auth system | Turbo already has ANS-104 auth | Never |
| Separate user database | Turbo already has users | Never |
| Separate billing | Turbo credits work | Never |
| Email/password auth | Wallet auth works | If customers demand |
| SAML/OIDC SSO | Enterprise feature | When enterprise requires |
| Webhooks | Nice to have | When customer needs |
| SDKs | Curl works | After API stable |

---

## API Key Format

```
ario_prod_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
└──┬───┘ └─┬─┘ └──────────────┬──────────────┘
   │       │                   │
   prefix  env                 random (32 chars)
```

- **Prefix**: `ario_` (identifies as AR.IO key)
- **Environment**: `prod_`, `test_`, `dev_`
- **Random**: 32 character base62 string
- **Storage**: Only store argon2 hash, never plaintext
- **Display**: Show `ario_prod_a1b2...` (prefix + first 4)

---

## Route Scopes

API keys can be scoped to specific route categories for least-privilege access:

| Scope | Routes Covered | Example Use Case |
|-------|---------------|------------------|
| `data:read` | `GET /raw/:id`, `GET /:id`, `GET /:id/*` | Data retrieval apps |
| `chunks:read` | `GET /chunk/:offset`, `GET /chunk/:offset/data` | Low-level chunk access |
| `graphql` | `POST /graphql`, `GET /graphql` | GraphQL query apps |
| `arns:resolve` | `GET /ar-io/resolver/:name` | ArNS name resolution |
| `gateway:info` | `GET /ar-io/info`, `GET /ar-io/healthcheck` | Monitoring/status |
| `*` | All routes | Full access (default) |

### Scope Examples

```bash
# Create a GraphQL-only key
curl -X POST https://auth.gateway.example.com/keys \
  -H "Authorization: Bearer <jwt>" \
  -d '{ "name": "GraphQL App", "scopes": ["graphql"] }'

# Create a read-only data key
curl -X POST https://auth.gateway.example.com/keys \
  -H "Authorization: Bearer <jwt>" \
  -d '{ "name": "Data Reader", "scopes": ["data:read", "arns:resolve"] }'
```

**Security benefit**: If a scoped key leaks, attackers can only access permitted routes.

---

## API Key Types & Domain Restrictions

### Key Types

| Type | Allowed Origins | Use Case | Security |
|------|-----------------|----------|----------|
| **Server** | None (any origin) | Backend services, scripts | Key is kept secret server-side |
| **Browser** | Required | Frontend apps, SPAs | Key visible in browser, restricted by domain |

### Domain Restriction Security Model

Browser keys with domain restrictions provide defense-in-depth:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Why Domain Restrictions Work                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Browsers CANNOT spoof the Origin header (enforced by browser)       │
│                                                                      │
│  ✅ Protects against:                                                │
│     • Someone copying key from your site's source code               │
│     • Using your key on a different website                          │
│     • Casual abuse from leaked keys                                  │
│                                                                      │
│  ⚠️ Does NOT protect against:                                        │
│     • Server-side requests (can spoof any header)                    │
│     • Determined attacker with backend                               │
│                                                                      │
│  This is the same model used by:                                     │
│     • Google Maps API                                                │
│     • QuickNode                                                      │
│     • Firebase                                                       │
│     • Stripe (publishable keys)                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Allowed Origin Patterns

| Pattern | Matches | Does NOT Match |
|---------|---------|----------------|
| `myapp.com` | `myapp.com` | `sub.myapp.com`, `myapp.com:8080` |
| `*.myapp.com` | `sub.myapp.com`, `api.myapp.com` | `myapp.com` (no subdomain) |
| `localhost:3000` | `localhost:3000` | `localhost:8080` |
| `*.localhost:3000` | `sub.localhost:3000` | `localhost:3000` |

### Example: Creating a Browser Key

```bash
# Create a browser key with domain restrictions
curl -X POST https://auth.gateway.example.com/keys \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Frontend App",
    "type": "browser",
    "allowed_origins": [
      "myapp.com",
      "*.myapp.com",
      "localhost:3000"
    ]
  }'

# Response (key shown ONCE, save it!)
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "My Frontend App",
  "type": "browser",
  "key": "ario_prod_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "key_prefix": "ario_prod_a1b2",
  "allowed_origins": ["myapp.com", "*.myapp.com", "localhost:3000"]
}
```

### Using Browser Keys in Frontend Code

```javascript
// This is safe because the key is restricted to your domain
const response = await fetch('https://auth.gateway.example.com/v1/raw/TX_ID', {
  headers: {
    'X-API-Key': 'ario_prod_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6'
  }
});

// Browser automatically sends Origin header
// Auth service validates: Origin matches allowed_origins? ✅
```

### Adding Origins to Existing Keys

```bash
# Add a new allowed origin
curl -X POST https://auth.gateway.example.com/keys/{key_id}/origins \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "pattern": "staging.myapp.com" }'

# Remove an allowed origin
curl -X DELETE https://auth.gateway.example.com/keys/{key_id}/origins/{origin_id} \
  -H "Authorization: Bearer <jwt>"
```

---

## Error Response Format

```json
{
    "error": {
        "code": "RATE_LIMIT_EXCEEDED",
        "message": "You have exceeded your rate limit",
        "details": {
            "limit": 10,
            "window": "1s",
            "retry_after_ms": 450
        }
    }
}
```

Standard error codes:
- `MISSING_API_KEY` - No API key provided in request
- `INVALID_API_KEY` - Key doesn't exist or is revoked
- `EXPIRED_API_KEY` - Key has passed expiration date
- `ORIGIN_NOT_ALLOWED` - Request origin doesn't match allowed origins for browser key
- `ORIGIN_REQUIRED` - Browser key used without Origin header
- `IP_NOT_ALLOWED` - Request IP doesn't match allowed IPs for server key
- `SCOPE_NOT_ALLOWED` - API key doesn't have permission for this route
- `RATE_LIMIT_EXCEEDED` - Too many requests
- `QUOTA_EXCEEDED` - Monthly quota exceeded (soft limit)
- `GATEWAY_ERROR` - Upstream gateway error
- `INTERNAL_ERROR` - Unexpected error

---

## Deployment

### Docker Compose (Development)

```yaml
version: '3.8'
services:
  gas:
    build: .
    ports:
      - "4000:4000"
    environment:
      - DATABASE_URL=postgresql://gas:gas@postgres:5432/gas
      - REDIS_URL=redis://redis:6379
      - GATEWAY_URL=http://gateway:3000
      - JWT_SECRET=${JWT_SECRET}
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15
    environment:
      - POSTGRES_USER=gas
      - POSTGRES_PASSWORD=gas
      - POSTGRES_DB=gas
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Production

- Deploy GAS alongside existing ar-io-node
- Use existing PostgreSQL instance (add `gas` database)
- Use existing Redis instance (separate DB number)
- Put behind same load balancer as gateway

---

## Console Integration

The ar.io console (dashboard UI) connects to this auth service. Here's how they work together:

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ar.io Console (Frontend)                         │
│                     (Hosted on Arweave / permaweb)                       │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │  1. User clicks "Connect Wallet"                                    ││
│  │  2. Wallet extension (ArConnect/MetaMask/Phantom) opens             ││
│  │  3. User signs challenge message                                    ││
│  │  4. Console sends signature to GAS /auth/verify                     ││
│  │  5. GAS returns JWT                                                 ││
│  │  6. Console stores JWT in localStorage                              ││
│  │  7. All subsequent API calls include JWT in Authorization header    ││
│  └─────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS + CORS
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Gateway Auth Service (GAS)                            │
│                         https://auth.ar.io                               │
│                                                                          │
│  CORS Configuration:                                                     │
│  - Allow-Origin: https://console.ar.io, https://*.arweave.net           │
│  - Allow-Methods: GET, POST, DELETE, OPTIONS                            │
│  - Allow-Headers: Authorization, Content-Type, X-API-Key                │
│  - Allow-Credentials: true                                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Internal network
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         AR.IO Gateway                                    │
│                      http://gateway:3000                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### CORS Configuration

```typescript
// Fastify CORS setup for console integration
import cors from '@fastify/cors';

fastify.register(cors, {
  origin: [
    'https://console.ar.io',           // Production console
    'https://*.arweave.net',           // Arweave-hosted versions
    'http://localhost:3000',           // Local development
  ],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key'],
  credentials: true,                    // Allow cookies/auth headers
  maxAge: 86400,                        // Cache preflight for 24 hours
});
```

### Console Authentication Flow

```typescript
// Console frontend code (pseudocode)

async function connectWallet() {
  // 1. Detect wallet
  const wallet = await detectWallet(); // ArConnect, MetaMask, or Phantom
  const address = await wallet.getAddress();
  const chain = wallet.chain; // 'arweave', 'ethereum', 'solana'

  // 2. Get challenge from GAS
  const challengeRes = await fetch(
    `https://auth.ar.io/auth/challenge?wallet=${address}&chain=${chain}`
  );
  const { message, nonce } = await challengeRes.json();

  // 3. Sign challenge with wallet
  const signature = await wallet.signMessage(message);

  // 4. Verify signature and get JWT
  const verifyRes = await fetch('https://auth.ar.io/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: address, chain, signature, message }),
  });
  const { token, wallet: user, firstApiKey } = await verifyRes.json();

  // 5. Store JWT
  localStorage.setItem('gas_token', token);

  // 6. If new user, show the first API key
  if (firstApiKey) {
    showFirstKeyModal(firstApiKey);
  }

  return user;
}

// All subsequent API calls
async function apiCall(endpoint, options = {}) {
  const token = localStorage.getItem('gas_token');
  return fetch(`https://auth.ar.io${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  });
}
```

### Console API Endpoints Used

| Console Feature | GAS Endpoint | Method |
|-----------------|--------------|--------|
| Login | `/auth/challenge` + `/auth/verify` | GET + POST |
| Get user info | `/auth/me` | GET |
| Logout | `/auth/logout` | POST |
| List API keys | `/keys` | GET |
| Create API key | `/keys` | POST |
| Delete API key | `/keys/:id` | DELETE |
| Manage origins | `/keys/:id/origins` | GET/POST/DELETE |
| Manage IPs | `/keys/:id/ips` | GET/POST/DELETE |
| View usage | `/usage` | GET |
| Usage history | `/usage/history` | GET |
| Recent requests | `/requests` | GET |

### Environment Variables for CORS

```bash
# Add to GAS environment
CORS_ORIGINS=https://console.ar.io,https://*.arweave.net
CORS_CREDENTIALS=true
```

---

## Security Checklist

- [ ] API keys hashed with argon2id (never stored plaintext)
- [ ] JWT signed with strong secret (256-bit minimum)
- [ ] Rate limiting on all auth endpoints
- [ ] No secrets in logs (API keys, JWTs, etc.)
- [ ] HTTPS only (enforce at load balancer)
- [ ] SQL injection prevented (Prisma parameterization)
- [ ] API key not returned after creation (shown once only)
- [ ] Timing-safe comparison for key validation
- [ ] Origin validation for browser keys (check Origin/Referer header)
- [ ] Browser keys require at least one allowed origin
- [ ] Wildcard origin pattern matching tested (*.example.com)
- [ ] IP validation for server keys (when allowlist configured)
- [ ] CIDR pattern matching tested (10.0.0.0/8)
- [ ] Route scope enforcement (keys only access permitted routes)
- [ ] CORS headers set correctly for browser keys
- [ ] Request logs don't contain sensitive data (no full keys, no auth tokens)

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Time to first working proxy | 1 week |
| Time to customer pilot | 4 weeks |
| Proxy latency overhead | < 10ms |
| API key validation | < 5ms (cached) |

---

## Future Phases (Only If Needed)

### Phase 2: OAuth & Better UX
- GitHub OAuth signup
- Google OAuth
- Better error messages
- Code examples in docs

### Phase 3: Enterprise (When Customers Ask)
- OIDC SSO
- SAML SSO
- Multi-org / teams
- Audit logs

### Phase 4: Arweave Native
- Wallet authentication
- Turbo credit integration
- ArConnect support

---

## Summary

**Extend Turbo + Add Thin Proxy:**

| Component | What | Where |
|-----------|------|-------|
| **Turbo Payment Services** | Add API key management, usage tracking | Extend existing (AWS) |
| **Thin Proxy** | Key validation, rate limiting, proxying | New small repo (~500 lines) |
| **ar.io Console** | Add gateway dashboard section | Extend existing |
| **ar-io-node** | Unchanged | Existing |

**Timeline**: 3 weeks to customer pilot (2 parallel workstreams)

**New Code**: ~500 lines for thin proxy + Turbo extensions

**Cost**: $0 additional (extends existing infrastructure)

**Risk**: Very low - Turbo auth already proven, proxy is simple

---

## Key Developer Instructions

### For Turbo Team

1. Add gateway API key tables to existing database
2. Add `/v1/gateway/keys/*` endpoints (CRUD for API keys)
3. Add `/internal/gateway/*` endpoints (for proxy to sync keys + report usage)
4. Reuse existing ANS-104 auth - users are already authenticated
5. Add gateway section to billing (Turbo credits for gateway access)

### For Proxy Developer

1. Keep it minimal - ~500 lines of code total
2. Cache API keys in Redis (fetch from Turbo on miss)
3. Validate: origin, IP, scopes, rate limit
4. Proxy to ar-io-node, count bytes
5. Batch usage to Turbo every 60 seconds

### Turbo's Auth Pattern (ANS-104 Data Items)

**Important**: Turbo uses ANS-104 data item signatures for authentication. Users authenticate to Turbo via signed data items, then use API keys for gateway access.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     How It All Fits Together                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. User authenticates to Turbo (ANS-104 signed data item)              │
│  2. User creates gateway API key via Turbo API                          │
│  3. User puts API key in their app                                      │
│  4. App calls gateway through thin proxy with X-API-Key header          │
│  5. Proxy validates key (cached from Turbo), proxies to ar-io-node      │
│  6. Proxy reports usage to Turbo for billing                            │
│                                                                          │
│  Key insight: The signature IS the authentication                        │
│  - No separate "sign this challenge" step                               │
│  - User just signs a data item, signature proves ownership              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**For GAS implementation**, you have two options:

| Option | Description | Complexity |
|--------|-------------|------------|
| **A: Mirror Turbo exactly** | Accept ANS-104 signed data items for auth | Lower (reuse Turbo code) |
| **B: Simple challenge-response** | Sign a text message (as shown in this doc) | Also simple |

**Recommendation**: Start by talking to the Turbo team. If their ANS-104 verification code is easy to extract and reuse, use Option A. The signature verification is already battle-tested.

**ANS-104 Resources**:
- Spec: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md
- Used by: Turbo, Irys (formerly Bundlr), ar.io bundlers

The challenge-response flow in this doc is a fallback if ANS-104 is too complex to integrate. Both approaches prove wallet ownership - ANS-104 is just the "Arweave native" way.

---

## Developer Quick Start Experience

This is the flow we want for new users (inspired by QuickNode):

### First-Time User Flow (< 2 minutes to first request)

```
1. User lands on dashboard
   └─> "Connect Wallet" button (ArConnect, MetaMask, Phantom)

2. User signs challenge message
   └─> Account auto-created
   └─> Redirected to dashboard

3. Dashboard shows:
   ┌─────────────────────────────────────────────────────────────┐
   │  🎉 Welcome! Your first API key is ready.                   │
   │                                                              │
   │  API Key: ario_prod_a1b2c3d4...  [Copy]                     │
   │                                                              │
   │  Endpoint: https://auth.ar.io/v1                            │
   │                                                              │
   │  ┌─ Quick Start ─────────────────────────────────────────┐  │
   │  │                                                        │  │
   │  │  curl https://auth.ar.io/v1/raw/TX_ID \               │  │
   │  │    -H "X-API-Key: ario_prod_a1b2c3d4..."              │  │
   │  │                                                   [Copy] │  │
   │  └────────────────────────────────────────────────────────┘  │
   │                                                              │
   │  [JavaScript] [Python] [Go] [Rust]  <- toggle examples      │
   │                                                              │
   └─────────────────────────────────────────────────────────────┘

4. User copies curl command, runs it
   └─> Success! Data returned

5. Dashboard updates to show:
   - "1 request made" in usage
   - Request appears in "Recent Requests" log
```

### Auto-Generated First API Key

On first login, automatically create a "My First Key" API key:

```typescript
// On successful wallet auth, if this is a new user:
if (isNewUser) {
    const firstKey = await createApiKey({
        org_id: personalOrg.id,
        name: 'My First Key',
        type: 'server',  // Server key (no restrictions) for easy start
        scopes: ['*'],   // Full access
        expires_at: null // Never expires
    });

    // Return the key in the auth response so dashboard can display it
    return { token, wallet, firstApiKey: firstKey.plaintext };
}
```

### Code Examples (Show in Dashboard)

```javascript
// JavaScript (fetch)
const response = await fetch('https://auth.ar.io/v1/raw/TX_ID', {
  headers: { 'X-API-Key': 'YOUR_API_KEY' }
});
const data = await response.text();
```

```python
# Python (requests)
import requests

response = requests.get(
    'https://auth.ar.io/v1/raw/TX_ID',
    headers={'X-API-Key': 'YOUR_API_KEY'}
)
data = response.text
```

```bash
# curl
curl https://auth.ar.io/v1/raw/TX_ID \
  -H "X-API-Key: YOUR_API_KEY"
```

```go
// Go
req, _ := http.NewRequest("GET", "https://auth.ar.io/v1/raw/TX_ID", nil)
req.Header.Set("X-API-Key", "YOUR_API_KEY")
resp, _ := http.DefaultClient.Do(req)
```

### Dashboard Features (QuickNode-inspired)

```
┌─────────────────────────────────────────────────────────────────────┐
│  AR.IO Gateway Dashboard                          [wallet: 0x1234...] │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  📊 Usage This Month                              🔑 API Keys (3)    │
│  ┌──────────────────────────────┐                 ┌───────────────┐ │
│  │ Requests: 45,231 / 100,000   │                 │ My First Key  │ │
│  │ ████████████░░░░░░░░  45%    │                 │ Production    │ │
│  │                              │                 │ GraphQL App   │ │
│  │ Egress: 2.3 GB / 10 GB       │                 │ [+ New Key]   │ │
│  │ ██████░░░░░░░░░░░░░░  23%    │                 └───────────────┘ │
│  └──────────────────────────────┘                                    │
│                                                                      │
│  📝 Recent Requests                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ Time       Method  Path              Status  Duration  Bytes    ││
│  │ 12:34:56   GET     /raw/abc123...    200     45ms      1.2KB   ││
│  │ 12:34:52   POST    /graphql          200     123ms     4.5KB   ││
│  │ 12:34:48   GET     /ar-io/info       200     12ms      0.3KB   ││
│  │ 12:34:45   GET     /raw/xyz789...    404     8ms       0.1KB   ││
│  │ ...                                                             ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Management UX

When creating a new key, show a clear modal:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Create New API Key                                           [X]   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Name: [Production Backend________________]                          │
│                                                                      │
│  Type: (•) Server Key    ( ) Browser Key                            │
│                                                                      │
│  ┌─ Scopes ───────────────────────────────────────────────────────┐ │
│  │ [✓] All routes (*)                                             │ │
│  │ [ ] Data read only (data:read)                                 │ │
│  │ [ ] GraphQL only (graphql)                                     │ │
│  │ [ ] ArNS resolution (arns:resolve)                             │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─ Security (optional) ──────────────────────────────────────────┐ │
│  │ IP Allowlist: [10.0.0.0/8, 192.168.1.0/24_________________]    │ │
│  │               Leave empty to allow all IPs                      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  Expiration: [Never ▼]                                              │
│                                                                      │
│                              [Cancel]  [Create Key]                  │
└─────────────────────────────────────────────────────────────────────┘
```

After creation, show the key ONE TIME:

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✅ API Key Created                                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ⚠️  Copy this key now. You won't be able to see it again!         │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ ario_prod_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6              [Copy] ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  Quick test:                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │ curl https://auth.ar.io/v1/ar-io/info \                         ││
│  │   -H "X-API-Key: ario_prod_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"   ││
│  │                                                          [Copy] ││
│  └─────────────────────────────────────────────────────────────────┘│
│                                                                      │
│                                              [Done, I've saved it]   │
└─────────────────────────────────────────────────────────────────────┘
```
