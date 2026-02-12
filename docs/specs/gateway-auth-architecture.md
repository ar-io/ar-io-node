# Gateway Auth Service - Proposed Architecture

## For Developer Implementation

**Date**: 2026-02-12
**Status**: Ready for Development

---

## Executive Summary

Build a minimal, pragmatic authentication proxy that can be deployed in **2-4 weeks** for the initial customer, with a clear path to add features as demand proves out.

### Reality Check

| Factor | Implication |
|--------|-------------|
| 1 potential customer | Don't over-engineer for scale we don't have |
| No budget for paid services | Eliminate Auth0, WorkOS, Ory Enterprise |
| Need to prove value fast | MVP in weeks, not months |
| Existing ar.io infra | Use what we have (PostgreSQL, Redis) |

### What We Actually Need (Phase 1)

| Need | Solution |
|------|----------|
| Authenticate API requests | API keys (simple, no OAuth complexity) |
| Track usage | Count requests + bytes per key |
| Enforce limits | Rate limiting + quota checks |
| User signup | Email/password (can add OAuth later) |
| Dashboard | Integrate into existing ar.io console |

### What We DON'T Need Yet

| Feature | Why Defer |
|---------|-----------|
| SAML SSO | No enterprise customers asking for it yet |
| OIDC SSO | Same - add when customer demands it |
| Multi-org/teams | Single customer = single org for now |
| Webhooks | Nice to have, not MVP |
| SDKs | Curl + docs is fine initially |
| Wallet auth | Phase 2 after basics work |

---

## Recommended Approach: Minimal Custom Build

### Why Not The Others?

| Approach | Verdict | Reason |
|----------|---------|--------|
| **Auth0** | ❌ Reject | $800+/month - way too expensive for 1 customer |
| **WorkOS** | ❌ Reject | $125/SSO connection - paying for features we don't need |
| **Keycloak** | ❌ Reject | Java monolith, overkill, ops burden |
| **Authentik** | ❌ Reject | Still overkill, another system to manage |
| **Ory Stack** | ❌ Reject | 3 services to orchestrate, SAML needs paid license |
| **Full Custom** | ⚠️ Too much | 12-16 weeks is too long for unproven market |
| **Minimal Custom** | ✅ Accept | Build exactly what we need, nothing more |

### Core Principle

**Build the simplest thing that could possibly work, then iterate.**

---

## Phase 1 Architecture (MVP - 2-4 weeks)

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Application                           │
│              (uses API key in X-API-Key header)                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Gateway Auth Service (GAS)                    │
│                         Node.js / Fastify                        │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Request Flow                           │ │
│  │                                                             │ │
│  │  1. Extract API key from header                             │ │
│  │  2. Validate key against PostgreSQL                         │ │
│  │  3. Check rate limit (Redis)                                │ │
│  │  4. Check quota (Redis counter)                             │ │
│  │  5. Proxy request to gateway                                │ │
│  │  6. Stream response back                                    │ │
│  │  7. Increment usage counters (Redis)                        │ │
│  │  8. Async: persist usage to PostgreSQL                      │ │
│  │                                                             │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  PostgreSQL  │  │    Redis     │  │   Fastify    │          │
│  │              │  │              │  │   Routes     │          │
│  │  - users     │  │  - sessions  │  │              │          │
│  │  - api_keys  │  │  - rate lim  │  │  /auth/*     │          │
│  │  - usage     │  │  - counters  │  │  /keys/*     │          │
│  │  - orgs      │  │              │  │  /usage/*    │          │
│  └──────────────┘  └──────────────┘  │  /proxy/*    │          │
│                                       └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      AR.IO Gateway                               │
│                  (existing ar-io-node)                          │
└─────────────────────────────────────────────────────────────────┘
```

### Tech Stack (Minimal)

| Component | Technology | Why |
|-----------|------------|-----|
| **Runtime** | Node.js 20 | Same as ar-io-node, team knows it |
| **Framework** | Fastify | Fast, TypeScript, minimal overhead |
| **Database** | PostgreSQL | Already have it, self-hosted |
| **Cache** | Redis | Already have it, self-hosted |
| **ORM** | Prisma | Type-safe, good migrations |
| **Auth** | Custom (simple) | Just API keys + email/password |
| **Password** | argon2 | Industry standard, one dependency |
| **JWT** | jose | For dashboard sessions only |
| **Proxy** | undici | Fast HTTP client, streams well |
| **Validation** | zod | Type-safe request validation |

### Database Schema (Minimal)

```sql
-- Users (for dashboard access)
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Organizations (1 per user for now, supports multi later)
CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    owner_id UUID REFERENCES users(id),

    -- Quotas (simple for now)
    monthly_request_limit BIGINT DEFAULT 100000,
    monthly_egress_limit BIGINT DEFAULT 1073741824, -- 1GB
    rate_limit_rps INT DEFAULT 10,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- API Keys
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    name VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(12) NOT NULL,      -- "ario_prod_" + first 4 chars
    key_hash VARCHAR(255) NOT NULL,        -- argon2 hash

    -- Simple permissions
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMPTZ,                -- NULL = never expires

    -- Tracking
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage (daily aggregates - simple)
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
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix) WHERE is_active = TRUE;
CREATE INDEX idx_usage_daily_org_date ON usage_daily(org_id, date);
```

### API Endpoints (Minimal)

```
# Authentication (for dashboard)
POST   /auth/register          # Create account
POST   /auth/login             # Get JWT for dashboard
POST   /auth/logout            # Invalidate session

# API Keys
GET    /keys                   # List my keys
POST   /keys                   # Create key (returns secret once)
DELETE /keys/:id               # Revoke key

# Usage
GET    /usage                  # Get current period usage
GET    /usage/history          # Get daily breakdown

# Proxy (the main event)
ALL    /v1/*                   # Proxy to gateway with auth
```

### Request Flow (Detailed)

```typescript
// Pseudocode for main proxy handler

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
```

### Environment Variables

```bash
# Required
DATABASE_URL=postgresql://gas:pass@localhost:5432/gas
REDIS_URL=redis://localhost:6379
GATEWAY_URL=http://localhost:3000  # ar-io-node
JWT_SECRET=<random-64-chars>

# Optional
PORT=4000
LOG_LEVEL=info
API_KEY_CACHE_TTL=300              # 5 minutes
RATE_LIMIT_WINDOW=1000             # 1 second
```

---

## What To Build (Ordered)

### Week 1: Core Proxy

- [ ] Project setup (Fastify, TypeScript, Prisma)
- [ ] Database schema + migrations
- [ ] API key validation endpoint
- [ ] Proxy handler with basic auth check
- [ ] Request counting (Redis)
- [ ] Basic rate limiting

**Milestone**: Can proxy requests with valid API key

### Week 2: User Management

- [ ] User registration (email/password)
- [ ] User login (JWT session)
- [ ] API key CRUD endpoints
- [ ] Key creation returns secret once
- [ ] Key listing (shows prefix only)

**Milestone**: User can sign up and create API keys

### Week 3: Usage & Quotas

- [ ] Byte counting on responses
- [ ] Usage persistence to PostgreSQL
- [ ] Quota checking (soft limits)
- [ ] Usage API endpoint
- [ ] Daily aggregation job

**Milestone**: Can track and report usage

### Week 4: Polish & Deploy

- [ ] Error handling polish
- [ ] OpenAPI spec generation
- [ ] Docker compose setup
- [ ] Basic health checks
- [ ] Deploy to staging

**Milestone**: Ready for customer pilot

---

## What NOT To Build (Yet)

| Feature | When to Add |
|---------|-------------|
| OAuth (GitHub, Google) | When users ask for it |
| SAML/OIDC SSO | When enterprise customer requires it |
| Multi-org / teams | When a customer needs teams |
| Webhooks | When a customer needs notifications |
| Wallet auth | Phase 2 after basics proven |
| SDK | After API is stable |
| Fancy dashboard | ar.io console integration later |

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

**Build the simplest possible authenticated proxy:**

1. **API keys** for authentication (not OAuth, not SAML)
2. **Redis** for rate limiting and counters
3. **PostgreSQL** for users, keys, and usage
4. **Fastify** for fast, simple Node.js server
5. **Proxy** requests to existing ar-io-node

**Timeline**: 4 weeks to customer pilot

**Cost**: $0 additional (using existing infrastructure)

**Risk**: Low - simple architecture, proven patterns
