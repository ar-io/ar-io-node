# Gateway Auth Service - Proposed Architecture

## For Developer Implementation

**Date**: 2026-02-13
**Status**: Ready for Development

---

## Executive Summary

Build a minimal authentication proxy using **wallet-based auth** (same as Turbo platform), deployable in **2-3 weeks** for the initial customer.

### Key Insight

**Use the same wallet auth that Turbo already uses.** This means:
- No email/password to build
- No OAuth (GitHub, Google) complexity
- No password reset flows
- No email verification
- Crypto-native users already have wallets

### Reality Check

| Factor | Implication |
|--------|-------------|
| 1 potential customer | Don't over-engineer |
| Turbo already has wallet auth | Reuse that pattern |
| Crypto-native audience | They have wallets, use them |
| No budget for paid services | $0 third-party auth costs |

### What We Actually Need (Phase 1)

| Need | Solution |
|------|----------|
| User authentication | Wallet signature (Arweave/ETH/Solana) |
| API request auth | API keys tied to wallet address |
| Track usage | Count requests + bytes per key |
| Enforce limits | Rate limiting + quota checks |
| Dashboard | Integrate into existing ar.io console |

### What We DON'T Need

| Feature | Why Skip |
|---------|----------|
| Email/password | Wallet auth is simpler and already proven |
| OAuth (GitHub, Google) | Adds complexity, users have wallets |
| SAML/OIDC SSO | Enterprise feature, add later if needed |
| Email verification | No emails = no verification needed |
| Password reset | No passwords = no reset flow |

---

## Recommended Approach: Wallet Auth + API Keys

### Why Wallet Auth?

| Reason | Benefit |
|--------|---------|
| **Already built for Turbo** | Reuse existing auth patterns/code |
| **Crypto-native audience** | Users already have wallets |
| **No passwords to manage** | No hashing, no reset flows, no breaches |
| **No email infrastructure** | No verification, no transactional emails needed |
| **Multi-chain support** | Arweave, Ethereum, Solana - same pattern |
| **Decentralized identity** | Aligns with Arweave/permaweb ethos |

### Why Not The Others?

| Approach | Verdict | Reason |
|----------|---------|--------|
| **Email/Password** | ❌ Skip | More complexity, Turbo doesn't use it |
| **OAuth (GitHub/Google)** | ❌ Skip | Users have wallets, unnecessary |
| **Auth0/WorkOS** | ❌ Reject | Expensive, overkill |
| **Keycloak/Ory** | ❌ Reject | Way overkill for wallet auth |

### Core Principle

**Use what Turbo already does. Don't reinvent auth.**

---

## Phase 1 Architecture (MVP - 2-3 weeks)

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        User with Wallet                          │
│            (ArConnect, MetaMask, Phantom, etc.)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                    Signs challenge message
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Gateway Auth Service (GAS)                    │
│                         Node.js / Fastify                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Authentication Flow                      │ │
│  │                                                             │ │
│  │  1. GET /auth/challenge?wallet=<address>                    │ │
│  │     → Returns: { challenge: "Sign this: <nonce>:<ts>" }     │ │
│  │                                                             │ │
│  │  2. POST /auth/verify                                       │ │
│  │     → Body: { wallet, signature, challenge }                │ │
│  │     → Verify signature matches wallet                       │ │
│  │     → Returns: { token: <JWT>, expires_at }                 │ │
│  │                                                             │ │
│  │  3. Use JWT for dashboard, API key for programmatic access  │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    API Request Flow                         │ │
│  │                                                             │ │
│  │  1. Extract API key from X-API-Key header                   │ │
│  │  2. Validate key (Redis cache → PostgreSQL)                 │ │
│  │  3. Check rate limit (Redis sliding window)                 │ │
│  │  4. Check quota (Redis counter)                             │ │
│  │  5. Proxy request to gateway                                │ │
│  │  6. Stream response, count bytes                            │ │
│  │  7. Update usage counters (async)                           │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  PostgreSQL  │  │    Redis     │  │   Fastify    │          │
│  │              │  │              │  │   Routes     │          │
│  │  - wallets   │  │  - sessions  │  │              │          │
│  │  - api_keys  │  │  - rate lim  │  │  /auth/*     │          │
│  │  - usage     │  │  - counters  │  │  /keys/*     │          │
│  │  - orgs      │  │  - nonces    │  │  /usage/*    │          │
│  └──────────────┘  └──────────────┘  │  /v1/*       │          │
│                                       └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AR.IO Gateway                               │
│                  (existing ar-io-node)                          │
└─────────────────────────────────────────────────────────────────┘
```

### Wallet Auth Flow (Detailed)

```
┌──────────┐          ┌──────────┐          ┌──────────┐
│  Wallet  │          │   GAS    │          │   DB     │
│ (client) │          │  Server  │          │          │
└────┬─────┘          └────┬─────┘          └────┬─────┘
     │                     │                     │
     │ GET /auth/challenge │                     │
     │ ?wallet=<addr>      │                     │
     │────────────────────>│                     │
     │                     │                     │
     │                     │ Store nonce        │
     │                     │────────────────────>│
     │                     │                     │
     │   { challenge }     │                     │
     │<────────────────────│                     │
     │                     │                     │
     │  [User signs msg]   │                     │
     │                     │                     │
     │ POST /auth/verify   │                     │
     │ {wallet, sig, msg}  │                     │
     │────────────────────>│                     │
     │                     │                     │
     │                     │ Verify nonce valid │
     │                     │────────────────────>│
     │                     │                     │
     │                     │ Verify signature    │
     │                     │ (crypto library)    │
     │                     │                     │
     │                     │ Create/get user     │
     │                     │────────────────────>│
     │                     │                     │
     │                     │ Issue JWT           │
     │                     │                     │
     │   { token, user }   │                     │
     │<────────────────────│                     │
     │                     │                     │
```

### Tech Stack (Minimal)

| Component | Technology | Why |
|-----------|------------|-----|
| **Runtime** | Node.js 20 | Same as ar-io-node, team knows it |
| **Framework** | Fastify | Fast, TypeScript, minimal overhead |
| **Database** | PostgreSQL | Already have it, self-hosted |
| **Cache** | Redis | Already have it, self-hosted |
| **ORM** | Prisma | Type-safe, good migrations |
| **JWT** | jose | Session tokens after wallet auth |
| **Proxy** | undici | Fast HTTP client, streams well |
| **Validation** | zod | Type-safe request validation |

### Wallet Signature Verification Libraries

| Chain | Library | Notes |
|-------|---------|-------|
| **Arweave** | `arweave` | Use existing Turbo verification code |
| **Ethereum** | `ethers` or `viem` | SIWE-style message verification |
| **Solana** | `@solana/web3.js` | Ed25519 signature verification |

**Note**: Check what Turbo uses and mirror that exactly.

### Database Schema (Minimal)

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

    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,                   -- NULL = never

    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
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

-- Indexes
CREATE INDEX idx_wallets_address ON wallets(address, chain);
CREATE INDEX idx_auth_challenges_wallet ON auth_challenges(wallet_address)
    WHERE used_at IS NULL AND expires_at > NOW();
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix) WHERE is_active = TRUE;
CREATE INDEX idx_usage_daily_org_date ON usage_daily(org_id, date);
```

### API Endpoints (Minimal)

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
       { name: "My App" }

DELETE /keys/:id               # Revoke key

# Usage
GET    /usage                  # Get current period usage
GET    /usage/history          # Get daily breakdown

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

// Pseudocode for main proxy handler (unchanged - uses API keys)

async function proxyHandler(req, res) {
    // 1. Extract API key
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

    // 2. Validate key (cache lookup first, then DB)
    const keyData = await validateApiKey(apiKey);
    if (!keyData) return res.status(401).json({ error: 'Invalid API key' });
    if (keyData.expired) return res.status(401).json({ error: 'API key expired' });

    // 3. Check rate limit
    const rateLimitOk = await checkRateLimit(keyData.orgId, keyData.rateLimit);
    if (!rateLimitOk) {
        return res.status(429).json({
            error: 'Rate limit exceeded',
            retry_after: rateLimitOk.retryAfter
        });
    }

    // 4. Check quota (soft limit - warn but allow)
    const quota = await checkQuota(keyData.orgId);
    if (quota.exceeded) {
        res.setHeader('X-Quota-Exceeded', 'true');
        // Continue anyway (soft limit)
    }

    // 5. Proxy to gateway
    const gatewayUrl = process.env.GATEWAY_URL + req.url.replace('/v1', '');
    const response = await proxy(gatewayUrl, req);

    // 6. Stream response and count bytes
    let bytesTransferred = 0;
    response.body.on('data', chunk => bytesTransferred += chunk.length);

    // 7. Record usage (async, don't block response)
    response.body.on('end', () => {
        recordUsage(keyData.orgId, keyData.id, bytesTransferred).catch(log.error);
    });

    // 8. Return response
    return response.pipe(res);
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
apikey:{key_prefix}          # JSON: { orgId, keyHash, rateLimit, expires }

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

### Week 1: Wallet Auth + Core Proxy

- [ ] Project setup (Fastify, TypeScript, Prisma)
- [ ] Database schema + migrations
- [ ] Wallet auth endpoints (challenge/verify)
- [ ] **Copy signature verification from Turbo** (Arweave, ETH, Solana)
- [ ] JWT issuance after successful auth
- [ ] API key validation
- [ ] Proxy handler with API key auth
- [ ] Basic rate limiting (Redis)

**Milestone**: User can authenticate with wallet, create API key, make proxied requests

### Week 2: Usage Tracking + Dashboard API

- [ ] Request counting (Redis)
- [ ] Byte counting on responses
- [ ] Usage persistence to PostgreSQL (async)
- [ ] Quota checking (soft limits)
- [ ] API key CRUD endpoints
- [ ] Usage API endpoints
- [ ] Daily aggregation job (cron)

**Milestone**: Full usage tracking, API keys working, usage visible via API

### Week 3: Polish & Deploy

- [ ] Error handling polish
- [ ] OpenAPI spec generation
- [ ] Docker compose setup
- [ ] Health check endpoints
- [ ] Prometheus metrics endpoint
- [ ] Deploy to staging
- [ ] Test with initial customer

**Milestone**: Ready for customer pilot

### Optional Week 4: Console Integration

- [ ] CORS setup for ar.io console
- [ ] API endpoints for console dashboard
- [ ] Any console-specific adjustments

**Milestone**: Integrated into ar.io console UI

---

## What NOT To Build (Yet)

| Feature | Why Skip | When to Add |
|---------|----------|-------------|
| Email/password auth | Wallet auth is simpler | Probably never |
| OAuth (GitHub, Google) | Users have wallets | If users request it |
| SAML/OIDC SSO | Enterprise feature | When enterprise customer requires it |
| Multi-org / teams | Single customer = single org | When customer needs teams |
| Webhooks | Nice to have | When customer needs notifications |
| SDKs | Curl is fine initially | After API is stable |
| Email notifications | No email in system | If we add email auth |

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
- `INVALID_API_KEY` - Key doesn't exist or is revoked
- `EXPIRED_API_KEY` - Key has passed expiration date
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

## Security Checklist

- [ ] API keys hashed with argon2id (never stored plaintext)
- [ ] JWT signed with strong secret (256-bit minimum)
- [ ] Rate limiting on all auth endpoints
- [ ] No secrets in logs
- [ ] HTTPS only (enforce at load balancer)
- [ ] SQL injection prevented (Prisma parameterization)
- [ ] API key not returned after creation
- [ ] Timing-safe comparison for key validation

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

**Build wallet-authenticated proxy using same auth as Turbo:**

1. **Wallet auth** (Arweave/ETH/Solana) - reuse Turbo's verification code
2. **API keys** for programmatic access (tied to wallet)
3. **Redis** for rate limiting and counters
4. **PostgreSQL** for wallets, keys, and usage
5. **Fastify** for fast, simple Node.js server
6. **Proxy** requests to existing ar-io-node

**Timeline**: 3 weeks to customer pilot

**Cost**: $0 additional (using existing infrastructure, no email service needed)

**Risk**: Very low - wallet auth already proven in Turbo

---

## Key Developer Instructions

1. **Start with Turbo's wallet verification code** - don't reinvent it
2. **Support all three chains** (Arweave, Ethereum, Solana) from day 1
3. **Challenge-response pattern** prevents replay attacks
4. **JWTs for dashboard sessions**, API keys for programmatic access
5. **Keep it simple** - we can add complexity later if needed

### First Thing To Do

Ask the Turbo team: "Can I get the wallet signature verification code you use for auth?"

That's the core of this system. Everything else is straightforward CRUD + proxying.
