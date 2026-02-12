# AR.IO Gateway Authentication Service PRD

## Product Requirements Document

**Version**: 1.0
**Status**: Draft
**Author**: Engineering
**Date**: 2026-02-12

---

## Executive Summary

This document defines requirements for an authentication and metering sidecar service ("Gateway Auth Service" or "GAS") that enables AR.IO Gateway operators to offer authenticated, metered, multi-tenant access to their gateways as a PaaS offering.

The service will be a standalone application that sits in front of or alongside the AR.IO Gateway, handling authentication, authorization, usage metering, and tenant management while the gateway focuses on its core function of serving Arweave data.

### Goals

1. **Enterprise-Ready Authentication**: SSO integration with major identity providers
2. **Self-Service Multi-Tenancy**: Users sign up, create organizations, and manage their own access
3. **Usage Metering**: Track bytes transferred and request counts per user/org/API
4. **Subscription Billing**: Monthly usage-based billing with soft quota limits
5. **Operator Simplicity**: Easy to deploy, configure, and operate alongside existing gateways

### Non-Goals (Current Phase)

- AR.IO token staking integration
- x402 payment integration (disabled on authenticated gateways)
- Compliance certifications (SOC2, HIPAA, GDPR)
- Gateway-per-customer isolation (handled by separate deployments)
- GraphQL query complexity limits
- Data-level access control (specific ArNS names or TX IDs)

---

## Integration Context

### Existing AR.IO Ecosystem

GAS integrates with the existing AR.IO ecosystem:

| Existing Service | Integration |
|-----------------|-------------|
| **ar.io Console** | Dashboard UI integrated into existing console (Arweave-hosted) |
| **ArDrive Turbo** | Unified credits for uploads AND gateway access |
| **AR.IO Gateways** | GAS sits in front of managed gateway clusters |
| **ArNS** | Name resolution through authenticated gateway |

### Relationship to Existing Services

AR.IO already offers pay-as-you-go and free services for:
- **Data uploads** via ArDrive Turbo credits
- **Data access** via public gateways

GAS extends this by providing:
- **Authenticated access** with usage tracking per user/org
- **Enterprise features** (SSO, team management, SLAs)
- **Unified billing** across uploads and gateway access

### Account Linking Strategy

Users may already have:
- **ArDrive/Turbo accounts** with credit balances
- **Arweave wallets** with transaction history
- **ar.io console accounts** (if exists)

GAS should:
1. Allow linking existing Arweave wallets to GAS accounts
2. Display Turbo credit balance in dashboard
3. Allow Turbo credits to pay for gateway usage (Phase 2)
4. Support "Sign in with Arweave" as primary auth for crypto-native users

---

## Architecture Overview

### Deployment Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ar.io Console (Arweave)                            │
│                    Dashboard UI integrated into existing app                 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │ API calls
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Load Balancer                                   │
│                         (nginx/cloudflare/etc)                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
┌───────────────────────────────────┐   ┌───────────────────────────────────┐
│    Gateway Auth Service (GAS)      │   │     ar.io Console API (existing)  │
│         (API Backend)              │   │                                   │
│  ┌─────────────┐  ┌─────────────┐ │   └───────────────────────────────────┘
│  │   Auth      │  │   Metering  │ │
│  │   Module    │  │   Module    │ │
│  └─────────────┘  └─────────────┘ │
│  ┌─────────────┐  ┌─────────────┐ │
│  │   Proxy     │  │   API       │ │
│  │   Module    │  │   (REST)    │ │
│  └─────────────┘  └─────────────┘ │
│         │                         │
│  ┌─────────────┐  ┌─────────────┐ │
│  │  PostgreSQL │  │    Redis    │ │
│  │(self-hosted)│  │(self-hosted)│ │
│  └─────────────┘  └─────────────┘ │
└───────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AR.IO Gateway Cluster                              │
│                     (existing ar-io-node instances)                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Dashboard hosting** | Integrated into ar.io console | Leverage existing Arweave-hosted app |
| **Database** | Self-hosted PostgreSQL | Co-located with GAS on AR.IO backend |
| **Cache** | Self-hosted Redis | Low latency, no external dependency |
| **Email** | Mailchimp Transactional | Reliable delivery, existing relationship |
| **Monitoring** | Prometheus + Honeycomb | Metrics + distributed tracing |

### Service Components

| Component | Responsibility |
|-----------|---------------|
| **Auth Module** | JWT issuance, SSO integration, API key validation, session management |
| **Metering Module** | Request counting, byte tracking, usage aggregation, quota enforcement |
| **Proxy Module** | Request forwarding, header injection, response interception |
| **Dashboard UI** | Self-service user/org management, usage visualization, key management |
| **PostgreSQL** | Users, orgs, API keys, usage records, audit logs |
| **Redis** | Session cache, rate limiting, real-time usage counters, revocation list |

### Request Flow

```
1. Request arrives at GAS
2. Auth Module validates:
   - JWT token (Authorization: Bearer <jwt>) OR
   - API Key (X-API-Key: <key> or Authorization: ApiKey <key>)
3. If invalid/missing → 401 Unauthorized (or redirect to login for browsers)
4. If valid:
   a. Check quota (soft limit warning in response header if near limit)
   b. Metering Module records request start
   c. Proxy Module forwards to Gateway with internal headers:
      - X-GAS-User-Id: <user_id>
      - X-GAS-Org-Id: <org_id>
      - X-GAS-Request-Id: <request_id>
   d. Gateway processes request
   e. Response streams back through GAS
   f. Metering Module records bytes transferred
5. Response returned to client
```

---

## Functional Requirements

### FR-1: User Authentication

#### FR-1.1: Email/Password Authentication
- Users can register with email and password
- Email verification required before account activation
- Password reset via email link
- Password requirements: minimum 12 characters, complexity rules configurable

#### FR-1.2: SSO - OIDC (OpenID Connect)
- Support for OIDC-compliant providers:
  - Google Workspace
  - Microsoft Azure AD / Entra ID
  - Auth0
  - Okta
  - Keycloak
  - Generic OIDC
- Configuration per organization (orgs can bring their own IdP)
- JIT (Just-In-Time) user provisioning from IdP claims
- Standard scopes: `openid`, `profile`, `email`

#### FR-1.3: SSO - SAML 2.0
- Support for SAML 2.0 SP-initiated flow
- Compatible with:
  - Okta
  - Azure AD
  - OneLogin
  - PingFederate
  - Generic SAML 2.0 IdP
- Metadata exchange (XML upload or URL)
- Attribute mapping configuration
- Signed assertions required

#### FR-1.4: OAuth 2.0 Social Login
- GitHub OAuth
- GitLab OAuth
- Google OAuth (consumer accounts)
- Optional: Twitter/X, Discord (developer community)

#### FR-1.5: Crypto Wallet Authentication (Phase 2)
- Ethereum wallet via SIWE (Sign-In with Ethereum)
- Arweave wallet via ArConnect
- Wallet address linked to user account
- Challenge-response signature verification

#### FR-1.6: Session Management
- JWT access tokens (15-minute expiry)
- Opaque refresh tokens (7-day expiry, stored hashed in DB)
- Refresh token rotation on use
- Logout invalidates refresh token (added to revocation list)
- Concurrent session limit configurable per org (default: unlimited)

### FR-2: API Key Management

#### FR-2.1: Key Creation
- Users create API keys with:
  - **Name**: Human-readable identifier
  - **Description**: Optional notes
  - **Expiration**: Optional date/time or "never"
  - **Route Scopes**: Which API routes the key can access (see FR-2.3)
  - **Organization**: Which org the key belongs to (if user has multiple)
- Key displayed once at creation (not stored in plaintext)
- Key format: `ario_<env>_<random_32_chars>` (e.g., `ario_prod_a1b2c3d4...`)

#### FR-2.2: Key Lifecycle
- **Active**: Key is valid and can be used
- **Expired**: Past expiration date, rejected with specific error
- **Revoked**: Manually disabled, rejected with specific error
- **Deleted**: Removed from system entirely
- Keys can be rotated (create new, revoke old in single operation)

#### FR-2.3: Route Scopes
API keys can be scoped to specific route categories:

| Scope | Routes Covered |
|-------|---------------|
| `data:read` | `GET /:id`, `GET /raw/:id`, `GET /:id/*path` |
| `chunks:read` | `GET /chunk/:offset`, `GET /chunk/:offset/data` |
| `graphql` | `POST /graphql`, `GET /graphql` |
| `arns:resolve` | `GET /ar-io/resolver/:name` |
| `gateway:info` | `GET /ar-io/info`, `GET /ar-io/healthcheck`, `GET /ar-io/peers` |
| `*` (wildcard) | All routes |

- Multiple scopes can be combined
- Requests to out-of-scope routes return 403 Forbidden
- Default for new keys: all scopes (`*`)

#### FR-2.4: Key Ownership
- Keys belong to a user AND an organization
- User can have personal org (single-user) or be member of team orgs
- Keys are isolated: users only see keys they created
- Org admins can view (but not reveal) all org keys
- Org admins can revoke any org key

### FR-3: Organization & Tenant Management

#### FR-3.1: Organization Model
```
Organization
├── name: string
├── slug: string (URL-safe identifier)
├── plan: enum (free, starter, growth, enterprise)
├── billing_email: string
├── sso_config: json (optional IdP configuration)
├── settings: json (quotas, features, etc.)
└── members: User[] (with roles)
```

#### FR-3.2: Organization Roles
| Role | Permissions |
|------|-------------|
| **Owner** | Full control, delete org, transfer ownership, manage billing |
| **Admin** | Manage members, manage all API keys, view all usage |
| **Member** | Create/manage own API keys, view own usage |

#### FR-3.3: Organization Isolation
- Each org has isolated:
  - API keys (not visible to other orgs)
  - Usage metrics (not visible to other orgs)
  - Audit logs (not visible to other orgs)
- No cross-org data leakage in any API response
- Org slug used in some URL paths for namespacing

#### FR-3.4: Personal Organizations
- Every user gets a personal org on signup
- Personal org name = user's display name
- Personal org has single member (the user) as owner
- Users can create additional orgs or be invited to existing orgs

### FR-4: Usage Metering

#### FR-4.1: Metrics Captured
Per request:
- **Timestamp**: When request occurred
- **User ID**: Authenticated user
- **Org ID**: Organization context
- **API Key ID**: Which key was used (null for JWT auth)
- **Route Category**: Which scope/category (data, chunks, graphql, etc.)
- **Method**: HTTP method
- **Path**: Request path (sanitized, no sensitive data)
- **Status Code**: Response status
- **Request Bytes**: Size of request body
- **Response Bytes**: Size of response body
- **Duration**: Request processing time (ms)

#### FR-4.2: Aggregation Levels
- **Real-time**: Redis counters for current billing period
- **Hourly**: Rolled up to PostgreSQL for dashboard queries
- **Daily**: Aggregated for billing calculations
- **Monthly**: Final billing period totals

#### FR-4.3: Usage Categories
Track separately for billing/display:
| Category | Description |
|----------|-------------|
| `data_egress` | Bytes transferred from data endpoints |
| `chunk_egress` | Bytes transferred from chunk endpoints |
| `graphql_requests` | Number of GraphQL operations |
| `arns_lookups` | Number of ArNS resolution requests |
| `total_requests` | Total API requests (all categories) |

#### FR-4.4: Retention
- Real-time counters: Current billing period only
- Hourly aggregates: 90 days
- Daily aggregates: 1 year
- Monthly aggregates: Indefinite (for billing history)

### FR-5: Quota & Billing

#### FR-5.1: Quota Model
Each organization has quotas:
```
Quotas
├── monthly_egress_bytes: number (e.g., 100GB)
├── monthly_requests: number (e.g., 1,000,000)
├── api_keys_limit: number (e.g., 10)
├── members_limit: number (e.g., 5)
└── rate_limit_rps: number (e.g., 100 requests/second)
```

#### FR-5.2: Soft Limit Enforcement
When quota exceeded:
- Requests continue to be served (soft limit)
- Response header added: `X-GAS-Quota-Exceeded: egress` (or `requests`)
- Dashboard shows warning banner
- Email notification sent to org billing contact (once per day)
- Overage tracked for billing

#### FR-5.3: Billing Integration (Phase 1)
- Manual billing based on usage reports
- Usage exportable for external billing system
- Placeholder for ArDrive Turbo credit integration

#### FR-5.4: Billing Integration (Phase 2 - Turbo Credits)
- Integration with ArDrive Turbo credit system
- Credits consumed based on usage
- Auto-top-up configuration
- Credit balance display in dashboard

### FR-6: Self-Service Dashboard

#### FR-6.1: Authentication Pages
- Login page (email/password + SSO buttons)
- Registration page
- Password reset flow
- Email verification flow
- SSO callback handling

#### FR-6.2: User Profile
- View/edit display name
- View/edit email (re-verification required)
- Change password
- View linked auth methods (SSO, wallets)
- Link additional auth methods
- Delete account (with confirmation, data retention notice)

#### FR-6.3: Organization Management
- View list of orgs user belongs to
- Create new organization
- Organization settings (for admins):
  - Edit name, billing email
  - Configure SSO (upload IdP metadata)
  - View/manage members
  - Invite members (via email)
  - Remove members
  - Change member roles
- Delete organization (owner only, with confirmation)

#### FR-6.4: API Key Management
- List all user's API keys (across orgs they belong to)
- Create new API key (with scope selection UI)
- View key details (name, created, expires, scopes, last used)
- Copy key ID (not secret) for support purposes
- Revoke key
- Delete key
- Rotate key (create new + revoke old)

#### FR-6.5: Usage Dashboard
- Current billing period overview:
  - Egress bytes (with quota bar)
  - Request counts (with quota bar)
  - Breakdown by category (pie chart)
- Historical usage:
  - Daily chart for last 30 days
  - Monthly totals for last 12 months
- Filter by:
  - Time range
  - API key (optional)
  - Route category (optional)
- Real-time counter (updates every ~10 seconds)

#### FR-6.6: Audit Log Viewer
- View audit events for user's actions
- Org admins can view all org audit events
- Filter by:
  - Event type
  - User (org admin only)
  - Time range
- Events shown:
  - Login/logout
  - API key created/revoked/deleted
  - Org member added/removed
  - Settings changed
  - SSO configured

### FR-7: Audit Logging

#### FR-7.1: Events Captured
| Event | Data |
|-------|------|
| `user.registered` | user_id, email, method (email/sso) |
| `user.login` | user_id, method, ip_address, user_agent |
| `user.logout` | user_id |
| `user.password_changed` | user_id |
| `user.email_changed` | user_id, old_email, new_email |
| `apikey.created` | user_id, org_id, key_id, scopes |
| `apikey.revoked` | user_id, org_id, key_id, revoked_by |
| `apikey.deleted` | user_id, org_id, key_id |
| `org.created` | user_id, org_id, org_name |
| `org.member_added` | org_id, user_id, added_by, role |
| `org.member_removed` | org_id, user_id, removed_by |
| `org.member_role_changed` | org_id, user_id, changed_by, old_role, new_role |
| `org.sso_configured` | org_id, provider_type, configured_by |
| `org.deleted` | org_id, deleted_by |

#### FR-7.2: Retention
- Audit logs retained for 90 days
- Automatic purge of logs older than 90 days
- No export required (per requirements)

### FR-8: Developer Experience

#### FR-8.1: Frictionless Onboarding
- **One-click signup**: GitHub OAuth as fastest path to first API call
- **No credit card required**: Generous free tier to start
- **Instant API key**: Generated immediately after signup
- **Time to first request**: < 2 minutes from landing page

#### FR-8.2: API Documentation
- **OpenAPI 3.0 specification**: Machine-readable API definition
- **Interactive documentation**: Swagger UI or similar
- **Try-it-now**: Execute API calls directly from docs
- **Code examples**: Curl, JavaScript, Python, Go for each endpoint
- **Authentication examples**: Clear examples for API key and JWT usage

#### FR-8.3: Getting Started Guide
- **Quickstart tutorial**: 5-minute guide to first API call
- **Language-specific guides**: Node.js, Python, Go, Rust
- **Use case examples**:
  - Fetching Arweave data
  - Querying via GraphQL
  - Resolving ArNS names
  - Building an app with gateway access

#### FR-8.4: SDKs (Phase 2)
- **TypeScript/JavaScript SDK**: Primary SDK, npm package
- **Python SDK**: For data science and scripting use cases
- **Auto-generated clients**: From OpenAPI spec for other languages

#### FR-8.5: Developer Dashboard
- **API key management**: Front and center in dashboard
- **Live request log**: See recent requests (last 100) in real-time
- **Usage visualization**: Clear graphs of consumption
- **Quota indicators**: Visual progress bars showing usage vs limits
- **Quick copy**: One-click copy for API keys, endpoints, examples

#### FR-8.6: Error Experience
- **Clear error messages**: Human-readable, actionable
- **Error codes**: Machine-parseable for programmatic handling
- **Troubleshooting links**: Link to relevant documentation
- **Example response**:
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "You have exceeded your rate limit of 100 requests/second",
    "details": {
      "limit": 100,
      "reset_at": "2024-01-15T10:30:00Z",
      "retry_after_seconds": 45
    },
    "docs_url": "https://docs.ar.io/gateway/rate-limits"
  }
}
```

#### FR-8.7: Sandbox/Test Mode (Phase 2)
- **Test API keys**: Prefixed with `ario_test_`
- **No quota consumption**: Test requests don't count toward limits
- **Simulated responses**: For testing error handling
- **Test environment**: Separate from production data

### FR-9: Free Tier & Pricing

#### FR-9.1: Free Tier Inclusions
| Resource | Free Tier Limit |
|----------|-----------------|
| Monthly egress | 1 GB |
| Monthly requests | 100,000 |
| API keys | 3 |
| Organizations | 1 (personal) |
| Team members | 1 (self) |
| Data retention | 30 days |
| Rate limit | 10 requests/second |
| Support | Community (Discord) |

#### FR-9.2: Upgrade Triggers
Display upgrade prompts when:
- Usage reaches 80% of free tier limit
- User tries to create 4th API key
- User tries to invite team member
- User tries to configure SSO

#### FR-9.3: Paid Tier Features (to be defined)
- Higher quotas
- Team collaboration
- SSO/SAML
- Priority support
- SLA guarantees
- Custom rate limits

### FR-10: Integration with Existing Services

#### FR-10.1: Turbo Credit Integration
- **Display balance**: Show Turbo credit balance in dashboard
- **Unified credits**: Use same credits for uploads and gateway access
- **Top-up flow**: Link to Turbo purchase flow
- **Usage breakdown**: Show credits used for uploads vs gateway

#### FR-10.2: Arweave Wallet Integration
- **Wallet linking**: Connect ArConnect or other Arweave wallets
- **Wallet-based auth**: Sign in with Arweave wallet
- **Transaction history**: View user's Arweave transaction history
- **Identity verification**: Prove ownership of Arweave addresses

#### FR-10.3: ar.io Console Integration
- **Embedded UI**: GAS dashboard as section in existing console
- **Shared navigation**: Consistent with console UX
- **Single session**: Same auth session across console features
- **Unified settings**: User profile shared with console

### FR-11: Webhooks (Phase 2)

#### FR-11.1: Webhook Events
| Event | Trigger |
|-------|---------|
| `usage.threshold` | Usage reaches 80%, 90%, 100% of quota |
| `apikey.created` | New API key created |
| `apikey.revoked` | API key revoked |
| `org.member_added` | Team member added |
| `billing.payment_failed` | Payment processing failed |

#### FR-11.2: Webhook Security
- **HMAC signatures**: Sign payloads with shared secret
- **Retry logic**: Retry failed deliveries with exponential backoff
- **Event logs**: Show delivery status in dashboard

---

## Non-Functional Requirements

### NFR-1: Performance

| Metric | Target |
|--------|--------|
| Auth validation latency | < 5ms (cached), < 50ms (cold) |
| Proxy overhead | < 10ms added latency |
| Dashboard page load | < 2 seconds |
| Concurrent users | 10,000+ |
| Requests per second | 10,000+ (per GAS instance) |

### NFR-2: Availability
- Target: 99.9% uptime
- Graceful degradation: If Redis unavailable, fall back to DB validation
- Health check endpoint for load balancer

### NFR-3: Security

#### NFR-3.1: Token Security
- JWT signed with RS256 (RSA) or ES256 (ECDSA)
- JWT contains: `sub` (user_id), `org` (org_id), `scopes`, `exp`, `iat`, `jti`
- Refresh tokens: 256-bit random, stored as SHA-256 hash
- API keys: 256-bit random, stored as Argon2id hash

#### NFR-3.2: Transport Security
- HTTPS required (enforced at load balancer)
- HSTS headers
- Secure cookie flags (HttpOnly, Secure, SameSite=Strict)

#### NFR-3.3: API Security
- Rate limiting on auth endpoints (prevent brute force):
  - Login: 5 attempts per minute per IP
  - Register: 3 attempts per minute per IP
  - Password reset: 3 attempts per minute per email
- CSRF protection for dashboard (state parameter in OAuth, CSRF tokens for forms)
- Input validation on all endpoints

#### NFR-3.4: Secret Management
- Signing keys loaded from environment variables
- Database credentials from environment variables
- No secrets in logs or error messages
- API key secrets never logged or returned after creation

### NFR-4: Scalability
- Horizontal scaling via multiple GAS instances
- Stateless design (all state in PostgreSQL/Redis)
- Redis cluster support for high availability
- Database connection pooling

### NFR-5: Observability
- Structured logging (JSON format)
- Metrics endpoint (Prometheus format):
  - Request counts by status, route
  - Latency histograms
  - Active sessions
  - Cache hit rates
- Distributed tracing support (OpenTelemetry)

---

## Technical Specifications

### Tech Stack Recommendation

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Runtime** | Node.js 20+ | Consistency with ar-io-node, async I/O |
| **Framework** | Fastify | High performance, TypeScript native |
| **Database** | PostgreSQL 15+ | JSONB for flexible schemas, robust |
| **Cache** | Redis 7+ | Session store, counters, pub/sub |
| **ORM** | Prisma | Type safety, migrations, good DX |
| **Auth Library** | passport.js or lucia | Mature, extensible, many strategies |
| **JWT Library** | jose | Standards compliant, performant |
| **Dashboard** | React + Vite | Modern, fast builds |
| **UI Components** | shadcn/ui | Accessible, customizable |
| **Proxy** | http-proxy or undici | Streaming support |

### Database Schema (Core Entities)

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE,
  email_verified BOOLEAN DEFAULT FALSE,
  password_hash VARCHAR(255), -- NULL for SSO-only users
  display_name VARCHAR(255),
  avatar_url VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ -- soft delete
);

-- External auth identities (SSO, OAuth, Wallet)
CREATE TABLE user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(50) NOT NULL, -- 'google', 'github', 'saml:okta', 'wallet:eth'
  provider_user_id VARCHAR(255) NOT NULL,
  provider_data JSONB, -- claims, metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(provider, provider_user_id)
);

-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  is_personal BOOLEAN DEFAULT FALSE,
  billing_email VARCHAR(255),
  plan VARCHAR(50) DEFAULT 'free',
  quotas JSONB DEFAULT '{}',
  settings JSONB DEFAULT '{}',
  sso_config JSONB, -- IdP metadata, attribute mappings
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Organization membership
CREATE TABLE org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member', -- owner, admin, member
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- API Keys
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  key_prefix VARCHAR(20) NOT NULL, -- first 8 chars for identification
  key_hash VARCHAR(255) NOT NULL, -- Argon2id hash
  scopes VARCHAR(50)[] NOT NULL DEFAULT ARRAY['*'],
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Refresh tokens
CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

-- Usage records (hourly aggregates)
CREATE TABLE usage_hourly (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  hour TIMESTAMPTZ NOT NULL, -- truncated to hour
  category VARCHAR(50) NOT NULL, -- data_egress, graphql_requests, etc.
  request_count BIGINT DEFAULT 0,
  bytes_in BIGINT DEFAULT 0,
  bytes_out BIGINT DEFAULT 0,
  UNIQUE(org_id, user_id, api_key_id, hour, category)
);

-- Audit log
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type VARCHAR(100) NOT NULL,
  event_data JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_api_keys_org ON api_keys(org_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_usage_hourly_org_hour ON usage_hourly(org_id, hour);
CREATE INDEX idx_audit_logs_org_created ON audit_logs(org_id, created_at);
```

### API Endpoints

#### Authentication
```
POST   /auth/register              # Email registration
POST   /auth/login                 # Email login
POST   /auth/logout                # Invalidate refresh token
POST   /auth/refresh               # Refresh access token
POST   /auth/forgot-password       # Send reset email
POST   /auth/reset-password        # Reset with token
GET    /auth/verify-email/:token   # Verify email

GET    /auth/sso/:provider         # Initiate SSO (redirect)
GET    /auth/sso/:provider/callback# SSO callback
POST   /auth/sso/saml/callback     # SAML ACS endpoint

GET    /auth/wallet/challenge      # Get signing challenge (Phase 2)
POST   /auth/wallet/verify         # Verify signature (Phase 2)
```

#### User
```
GET    /user/me                    # Get current user profile
PATCH  /user/me                    # Update profile
DELETE /user/me                    # Delete account
GET    /user/me/identities         # List linked auth methods
DELETE /user/me/identities/:id     # Unlink auth method
```

#### Organizations
```
GET    /orgs                       # List user's orgs
POST   /orgs                       # Create org
GET    /orgs/:slug                 # Get org details
PATCH  /orgs/:slug                 # Update org
DELETE /orgs/:slug                 # Delete org

GET    /orgs/:slug/members         # List members
POST   /orgs/:slug/members         # Invite member
PATCH  /orgs/:slug/members/:id     # Change role
DELETE /orgs/:slug/members/:id     # Remove member

GET    /orgs/:slug/sso             # Get SSO config
PUT    /orgs/:slug/sso             # Configure SSO
DELETE /orgs/:slug/sso             # Remove SSO
```

#### API Keys
```
GET    /orgs/:slug/keys            # List org's keys (user sees own, admin sees all)
POST   /orgs/:slug/keys            # Create key
GET    /orgs/:slug/keys/:id        # Get key details
PATCH  /orgs/:slug/keys/:id        # Update key (name, description)
DELETE /orgs/:slug/keys/:id        # Delete key
POST   /orgs/:slug/keys/:id/revoke # Revoke key
POST   /orgs/:slug/keys/:id/rotate # Rotate key
```

#### Usage
```
GET    /orgs/:slug/usage           # Get usage summary
GET    /orgs/:slug/usage/current   # Real-time current period
GET    /orgs/:slug/usage/history   # Historical data
```

#### Audit
```
GET    /orgs/:slug/audit           # Get audit logs (paginated)
```

#### Health
```
GET    /health                     # Health check
GET    /health/ready               # Readiness check
GET    /metrics                    # Prometheus metrics
```

### Gateway Integration

GAS adds headers to proxied requests:
```
X-GAS-User-Id: <uuid>
X-GAS-Org-Id: <uuid>
X-GAS-Key-Id: <uuid>           # If API key auth
X-GAS-Request-Id: <uuid>       # For correlation
X-GAS-Scopes: data:read,graphql
```

GAS reads response headers from Gateway:
```
Content-Length: <bytes>        # For metering
X-AR-IO-* headers              # Passed through to client
```

### Configuration (Environment Variables)

```bash
# Core
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Database (self-hosted PostgreSQL)
DATABASE_URL=postgresql://gas:password@localhost:5432/gas

# Cache (self-hosted Redis)
REDIS_URL=redis://localhost:6379

# JWT
JWT_PRIVATE_KEY=<RS256 private key PEM>
JWT_PUBLIC_KEY=<RS256 public key PEM>
JWT_ACCESS_TOKEN_TTL=900          # 15 minutes
JWT_REFRESH_TOKEN_TTL=604800      # 7 days

# API Keys
API_KEY_HASH_MEMORY=65536         # Argon2 memory cost
API_KEY_HASH_ITERATIONS=3         # Argon2 iterations
API_KEY_HASH_PARALLELISM=4        # Argon2 parallelism

# Gateway
GATEWAY_URL=http://localhost:4000 # AR.IO Gateway URL
GATEWAY_TIMEOUT=30000             # Proxy timeout ms

# OAuth Providers
GITHUB_CLIENT_ID=                 # Required for Phase 1
GITHUB_CLIENT_SECRET=
GOOGLE_CLIENT_ID=                 # Phase 2
GOOGLE_CLIENT_SECRET=
# ... etc for each provider

# Email (Mailchimp Transactional)
MAILCHIMP_API_KEY=
MAILCHIMP_FROM_EMAIL=noreply@ar.io
MAILCHIMP_FROM_NAME=AR.IO Gateway

# ar.io Console Integration
CONSOLE_URL=https://console.ar.io  # Arweave-hosted console
CORS_ORIGINS=https://console.ar.io

# Turbo Integration (Phase 4)
TURBO_API_URL=https://api.ardrive.io
TURBO_API_KEY=

# Monitoring
HONEYCOMB_API_KEY=                # Distributed tracing
PROMETHEUS_ENABLED=true           # Metrics endpoint

# Rate Limiting (auth endpoints)
AUTH_RATE_LIMIT_LOGIN=5           # per minute per IP
AUTH_RATE_LIMIT_REGISTER=3        # per minute per IP

# Free Tier Defaults
FREE_TIER_MONTHLY_EGRESS=1073741824     # 1GB
FREE_TIER_MONTHLY_REQUESTS=100000
FREE_TIER_API_KEYS_LIMIT=3
FREE_TIER_RATE_LIMIT_RPS=10             # requests per second
```

---

## User Stories

### Epic 1: User Registration & Authentication

#### US-1.1: Email Registration
**As a** new user
**I want to** register with my email and password
**So that** I can access the gateway service

**Acceptance Criteria:**
- [ ] Registration form accepts email and password
- [ ] Password must be at least 12 characters
- [ ] Email uniqueness validated
- [ ] Verification email sent with link
- [ ] Account inactive until email verified
- [ ] Verification link expires after 24 hours
- [ ] Can resend verification email

#### US-1.2: Email Login
**As a** registered user
**I want to** log in with my email and password
**So that** I can access my account

**Acceptance Criteria:**
- [ ] Login form accepts email and password
- [ ] Invalid credentials return generic error (no enumeration)
- [ ] Successful login returns JWT access token and refresh token
- [ ] Refresh token stored in HTTP-only cookie
- [ ] Failed login attempts rate limited (5/min/IP)

#### US-1.3: Password Reset
**As a** user who forgot my password
**I want to** reset my password via email
**So that** I can regain access to my account

**Acceptance Criteria:**
- [ ] "Forgot password" link on login page
- [ ] Enter email to receive reset link
- [ ] Reset link expires after 1 hour
- [ ] Reset link is single-use
- [ ] New password must meet requirements
- [ ] All existing sessions invalidated after reset

#### US-1.4: SSO Login (OIDC)
**As a** user whose organization uses OIDC
**I want to** log in with my corporate identity
**So that** I don't need a separate password

**Acceptance Criteria:**
- [ ] "Login with [Provider]" buttons for configured providers
- [ ] Redirect to IdP for authentication
- [ ] Handle callback and exchange code for tokens
- [ ] Create user account if first login (JIT provisioning)
- [ ] Map IdP claims to user profile
- [ ] Link to existing account if email matches

#### US-1.5: SSO Login (SAML)
**As a** user whose organization uses SAML
**I want to** log in with my corporate SSO
**So that** I can use existing credentials

**Acceptance Criteria:**
- [ ] Support SP-initiated SAML flow
- [ ] Redirect to IdP with SAML request
- [ ] Handle SAML response at ACS endpoint
- [ ] Validate signature on SAML assertion
- [ ] Extract attributes per org configuration
- [ ] Create/link user account

#### US-1.6: Social Login (GitHub/Google)
**As a** developer
**I want to** log in with my GitHub or Google account
**So that** I can quickly get started

**Acceptance Criteria:**
- [ ] GitHub OAuth button
- [ ] Google OAuth button
- [ ] Handle OAuth callback
- [ ] Create user on first login
- [ ] Link to existing account if email matches

#### US-1.7: Logout
**As a** logged-in user
**I want to** log out
**So that** my session is ended securely

**Acceptance Criteria:**
- [ ] Logout endpoint invalidates refresh token
- [ ] Refresh token added to revocation list
- [ ] HTTP-only cookie cleared
- [ ] Redirect to login page

#### US-1.8: Token Refresh
**As an** authenticated user
**I want to** automatically refresh my session
**So that** I don't have to re-login frequently

**Acceptance Criteria:**
- [ ] Refresh endpoint accepts refresh token
- [ ] Returns new access token if valid
- [ ] Rotates refresh token (old one invalid)
- [ ] Returns 401 if refresh token expired/revoked

### Epic 2: Organization Management

#### US-2.1: Create Organization
**As a** user
**I want to** create an organization
**So that** I can manage team access and billing

**Acceptance Criteria:**
- [ ] Create org with name and slug
- [ ] Slug must be unique and URL-safe
- [ ] Creator becomes owner
- [ ] Personal org cannot be created manually (auto-created)
- [ ] Org has default quotas based on plan

#### US-2.2: View Organization
**As an** org member
**I want to** view my organization details
**So that** I can see settings and quotas

**Acceptance Criteria:**
- [ ] View org name, slug, plan
- [ ] View quota limits and current usage
- [ ] View list of members (names and roles)
- [ ] See my role in the org

#### US-2.3: Update Organization
**As an** org admin
**I want to** update organization settings
**So that** I can customize the org

**Acceptance Criteria:**
- [ ] Edit org name
- [ ] Edit billing email
- [ ] Only owner/admin can edit

#### US-2.4: Invite Member
**As an** org admin
**I want to** invite new members
**So that** they can access the org

**Acceptance Criteria:**
- [ ] Invite by email address
- [ ] Select role for invitee (admin or member)
- [ ] Invitation email sent with link
- [ ] Invitation expires after 7 days
- [ ] Can cancel pending invitation

#### US-2.5: Manage Member Roles
**As an** org admin
**I want to** change member roles
**So that** I can control permissions

**Acceptance Criteria:**
- [ ] Change member from member to admin
- [ ] Change member from admin to member
- [ ] Cannot change owner role (must transfer ownership)
- [ ] Cannot demote yourself if you're the only admin

#### US-2.6: Remove Member
**As an** org admin
**I want to** remove members
**So that** they no longer have access

**Acceptance Criteria:**
- [ ] Remove any non-owner member
- [ ] Removed member's API keys remain (owned by org)
- [ ] Owner cannot be removed (must transfer ownership first)
- [ ] Member receives notification email

#### US-2.7: Transfer Ownership
**As an** org owner
**I want to** transfer ownership
**So that** someone else can manage the org

**Acceptance Criteria:**
- [ ] Select new owner from existing members
- [ ] Confirm with password/2FA
- [ ] Previous owner becomes admin
- [ ] Audit log entry created

#### US-2.8: Delete Organization
**As an** org owner
**I want to** delete the organization
**So that** all data is removed

**Acceptance Criteria:**
- [ ] Confirmation required (type org name)
- [ ] All API keys deleted
- [ ] All usage data deleted
- [ ] All audit logs deleted
- [ ] Members notified
- [ ] Personal orgs cannot be deleted (delete account instead)

#### US-2.9: Configure OIDC SSO
**As an** org admin
**I want to** configure OIDC for my org
**So that** members can login with our IdP

**Acceptance Criteria:**
- [ ] Enter client ID and secret
- [ ] Enter issuer URL (auto-discovery via .well-known)
- [ ] Configure attribute mapping
- [ ] Test configuration
- [ ] Enable/disable SSO

#### US-2.10: Configure SAML SSO
**As an** org admin
**I want to** configure SAML for my org
**So that** members can login with our IdP

**Acceptance Criteria:**
- [ ] Upload IdP metadata XML or enter URL
- [ ] Download SP metadata for IdP configuration
- [ ] Configure attribute mapping
- [ ] Test configuration
- [ ] Enable/disable SSO

### Epic 3: API Key Management

#### US-3.1: Create API Key
**As a** user
**I want to** create an API key
**So that** I can authenticate my applications

**Acceptance Criteria:**
- [ ] Enter key name (required)
- [ ] Enter description (optional)
- [ ] Select organization (if member of multiple)
- [ ] Select expiration (never, 30d, 90d, 1y, custom date)
- [ ] Select route scopes (checkboxes with "all" option)
- [ ] Key displayed once after creation
- [ ] Copy button for key
- [ ] Warning that key won't be shown again

#### US-3.2: List API Keys
**As a** user
**I want to** view my API keys
**So that** I can manage them

**Acceptance Criteria:**
- [ ] List shows all my keys across my orgs
- [ ] For each key: name, org, prefix, created, expires, last used
- [ ] Indicate expired/revoked status
- [ ] Filter by organization
- [ ] Sort by name, created, last used

#### US-3.3: View API Key Details
**As a** user
**I want to** view details of an API key
**So that** I understand its configuration

**Acceptance Criteria:**
- [ ] Show name, description, org
- [ ] Show prefix (first 8 chars) for identification
- [ ] Show scopes
- [ ] Show created date
- [ ] Show expiration date
- [ ] Show last used date and IP
- [ ] Show status (active, expired, revoked)

#### US-3.4: Revoke API Key
**As a** user
**I want to** revoke an API key
**So that** it can no longer be used

**Acceptance Criteria:**
- [ ] Revoke button with confirmation
- [ ] Key immediately stops working
- [ ] Key remains visible in list as "revoked"
- [ ] Audit log entry created

#### US-3.5: Delete API Key
**As a** user
**I want to** delete an API key
**So that** it's removed from my list

**Acceptance Criteria:**
- [ ] Delete button with confirmation
- [ ] Only revoked keys can be deleted
- [ ] Key removed from list
- [ ] Historical usage data retained

#### US-3.6: Rotate API Key
**As a** user
**I want to** rotate an API key
**So that** I can replace it securely

**Acceptance Criteria:**
- [ ] Rotate creates new key with same config
- [ ] Old key is automatically revoked
- [ ] New key displayed once
- [ ] Single atomic operation

#### US-3.7: Admin View All Org Keys
**As an** org admin
**I want to** see all keys in my org
**So that** I can audit and manage access

**Acceptance Criteria:**
- [ ] Toggle to show "all org keys" vs "my keys"
- [ ] See key metadata (name, owner, prefix, last used)
- [ ] Cannot see actual key values
- [ ] Can revoke any org key
- [ ] Can delete any revoked org key

### Epic 4: Gateway Access

#### US-4.1: Access with JWT
**As an** authenticated user
**I want to** access gateway APIs with my session
**So that** I can browse data in the dashboard

**Acceptance Criteria:**
- [ ] JWT accepted in Authorization: Bearer header
- [ ] Request forwarded to gateway with user context
- [ ] Usage metered to user's org
- [ ] 401 if token expired/invalid
- [ ] Refresh automatically if near expiry

#### US-4.2: Access with API Key
**As a** developer
**I want to** access gateway APIs with my API key
**So that** my applications can retrieve data

**Acceptance Criteria:**
- [ ] API key accepted in X-API-Key header
- [ ] API key accepted in Authorization: ApiKey header
- [ ] Request forwarded to gateway
- [ ] Usage metered to key's org
- [ ] 401 if key invalid/expired/revoked
- [ ] 403 if route not in key's scopes

#### US-4.3: Rate Limiting
**As a** gateway operator
**I want** users to be rate limited
**So that** no one can abuse the service

**Acceptance Criteria:**
- [ ] Per-org rate limit enforced
- [ ] 429 returned when exceeded
- [ ] Retry-After header included
- [ ] Rate limit headers in response:
  - X-RateLimit-Limit
  - X-RateLimit-Remaining
  - X-RateLimit-Reset

#### US-4.4: Quota Enforcement
**As a** user
**I want to** know when I'm near my quota
**So that** I can take action

**Acceptance Criteria:**
- [ ] X-GAS-Quota-Warning header when >80% used
- [ ] X-GAS-Quota-Exceeded header when >100% used
- [ ] Requests still served (soft limit)
- [ ] Dashboard shows warning banner

### Epic 5: Usage & Analytics

#### US-5.1: View Current Usage
**As a** user
**I want to** see my current billing period usage
**So that** I know how much I've consumed

**Acceptance Criteria:**
- [ ] Show current period dates
- [ ] Show egress bytes used / quota
- [ ] Show requests used / quota
- [ ] Progress bars for visual indication
- [ ] Updates in near real-time (~10s delay)

#### US-5.2: View Usage Breakdown
**As a** user
**I want to** see usage broken down by category
**So that** I understand what's using resources

**Acceptance Criteria:**
- [ ] Pie chart showing:
  - Data egress
  - Chunk egress
  - GraphQL requests
  - ArNS lookups
- [ ] Toggle between bytes and requests view
- [ ] Filter by API key

#### US-5.3: View Historical Usage
**As a** user
**I want to** see usage over time
**So that** I can identify trends

**Acceptance Criteria:**
- [ ] Daily chart for last 30 days
- [ ] Monthly totals for last 12 months
- [ ] Select time range
- [ ] Compare to previous period
- [ ] Filter by API key

#### US-5.4: Quota Alert Notification
**As a** user
**I want to** be notified when nearing quota
**So that** I can take action

**Acceptance Criteria:**
- [ ] Email sent at 80% usage
- [ ] Email sent at 100% usage
- [ ] Maximum one email per alert level per day
- [ ] Configurable alert thresholds (future)

### Epic 6: Audit & Compliance

#### US-6.1: View Audit Log
**As a** user
**I want to** see my activity history
**So that** I can verify actions taken

**Acceptance Criteria:**
- [ ] List of audit events
- [ ] Filter by event type
- [ ] Filter by date range
- [ ] Show: timestamp, event, details, IP
- [ ] Pagination for large lists

#### US-6.2: Admin Audit Log
**As an** org admin
**I want to** see all org activity
**So that** I can audit team actions

**Acceptance Criteria:**
- [ ] See events for all org members
- [ ] Filter by user
- [ ] Filter by event type
- [ ] Export not required per requirements

### Epic 7: Wallet Authentication (Phase 2)

#### US-7.1: Link Ethereum Wallet
**As a** user
**I want to** link my Ethereum wallet
**So that** I can login with my wallet

**Acceptance Criteria:**
- [ ] "Connect Wallet" button
- [ ] Support MetaMask, WalletConnect
- [ ] Sign SIWE message to verify ownership
- [ ] Wallet address linked to account
- [ ] Can unlink wallet

#### US-7.2: Link Arweave Wallet
**As a** user
**I want to** link my Arweave wallet
**So that** I can login with ArConnect

**Acceptance Criteria:**
- [ ] "Connect ArConnect" button
- [ ] Sign challenge message
- [ ] Wallet address linked to account
- [ ] Can unlink wallet

#### US-7.3: Login with Wallet
**As a** user with linked wallet
**I want to** login by signing a message
**So that** I don't need a password

**Acceptance Criteria:**
- [ ] "Login with Wallet" button
- [ ] Request signature of timestamped challenge
- [ ] Verify signature matches linked wallet
- [ ] Issue JWT tokens as normal

### Epic 8: Developer Experience

#### US-8.1: One-Click GitHub Signup
**As a** developer
**I want to** sign up with one click using GitHub
**So that** I can start using the API immediately

**Acceptance Criteria:**
- [ ] "Continue with GitHub" button prominent on signup page
- [ ] OAuth flow completes in single redirect
- [ ] Account created with GitHub email and avatar
- [ ] API key auto-generated on first signup
- [ ] Redirected to dashboard with key visible
- [ ] Time from click to API key < 30 seconds

#### US-8.2: View Interactive API Documentation
**As a** developer
**I want to** explore the API interactively
**So that** I can understand how to use it

**Acceptance Criteria:**
- [ ] OpenAPI spec available at `/openapi.json`
- [ ] Swagger UI at `/docs` or similar
- [ ] Can execute requests directly from docs
- [ ] Authentication pre-filled when logged in
- [ ] Code examples in multiple languages

#### US-8.3: Copy Code Examples
**As a** developer
**I want to** copy working code examples
**So that** I can integrate quickly

**Acceptance Criteria:**
- [ ] Code examples for curl, JavaScript, Python, Go
- [ ] Examples include authentication headers
- [ ] One-click copy button
- [ ] Examples use user's actual API key when logged in

#### US-8.4: View Live Request Log
**As a** developer
**I want to** see my recent API requests
**So that** I can debug issues

**Acceptance Criteria:**
- [ ] Dashboard shows last 100 requests
- [ ] Shows: timestamp, method, path, status, latency, bytes
- [ ] Updates in real-time (websocket or polling)
- [ ] Can filter by status code
- [ ] Can click to see request/response details

#### US-8.5: Understand Errors
**As a** developer
**I want** clear error messages
**So that** I can fix issues quickly

**Acceptance Criteria:**
- [ ] All errors return JSON with code, message, details
- [ ] Error codes are documented
- [ ] Errors include links to relevant documentation
- [ ] Rate limit errors include retry-after information

### Epic 9: Free Tier Experience

#### US-9.1: Start for Free
**As a** new user
**I want to** try the service without payment
**So that** I can evaluate before committing

**Acceptance Criteria:**
- [ ] No credit card required to sign up
- [ ] Free tier includes 1GB egress, 100k requests
- [ ] Clear display of free tier limits
- [ ] Usage counter shows consumption

#### US-9.2: See Upgrade Prompts
**As a** free tier user approaching limits
**I want to** see clear upgrade options
**So that** I can continue using the service

**Acceptance Criteria:**
- [ ] Banner at 80% usage: "You've used 80% of your free tier"
- [ ] Soft limit at 100%: requests continue with warning header
- [ ] Clear pricing information
- [ ] One-click upgrade flow

### Epic 10: Turbo Integration

#### US-10.1: See Turbo Balance
**As a** user with Turbo credits
**I want to** see my balance in the gateway dashboard
**So that** I know how much I can use

**Acceptance Criteria:**
- [ ] Turbo credit balance displayed in dashboard
- [ ] Balance updates after usage
- [ ] Link to top up credits

#### US-10.2: Pay with Turbo Credits
**As a** user
**I want to** use my Turbo credits for gateway access
**So that** I have unified billing

**Acceptance Criteria:**
- [ ] Gateway usage deducts from Turbo balance
- [ ] Clear conversion rate displayed
- [ ] Usage breakdown shows credits consumed

---

## Implementation Phases

### Phase 1: Core Authentication (MVP)
**Duration: 4-6 weeks**

**Focus**: Get developers making API calls ASAP

- GitHub OAuth signup (fastest path to API key)
- Email registration and login
- JWT + refresh token flow
- API key management (create, list, revoke)
- Single organization per user (personal org)
- Gateway proxy with metering
- Basic usage display
- PostgreSQL + Redis setup (self-hosted)
- OpenAPI spec + Swagger UI
- Integration scaffolding for ar.io console

**Deliverables:**
- Working GAS API backend
- API key authentication working
- Interactive API documentation
- Docker compose deployment
- Console integration endpoints ready

**Success Criteria:**
- Developer can go from signup to first API call in < 2 minutes
- API documentation is live and interactive

### Phase 2: Developer Experience & Social Auth
**Duration: 3-4 weeks**

**Focus**: Polish the developer journey

- Google OAuth
- Code examples in docs (curl, JS, Python, Go)
- Getting started guide
- Live request log in dashboard
- Clear error messages with docs links
- Usage visualization (charts)
- Quota warnings (80%, 100%)
- Email notifications (Mailchimp integration)

**Deliverables:**
- Multiple OAuth providers
- Comprehensive documentation
- Developer-friendly dashboard
- Email notification system

### Phase 3: Multi-Org & Enterprise SSO
**Duration: 4-6 weeks**

**Focus**: Enterprise readiness

- Multi-organization support
- Team member invitations
- Organization roles (owner, admin, member)
- OIDC SSO integration
- SAML SSO integration
- SSO configuration UI
- Audit log viewer

**Deliverables:**
- Full multi-tenancy
- Enterprise SSO
- Team collaboration features

### Phase 4: Arweave Integration
**Duration: 3-4 weeks**

**Focus**: Crypto-native features

- Arweave wallet authentication (ArConnect)
- Ethereum wallet authentication (SIWE)
- Wallet linking to accounts
- Turbo credit balance display
- Turbo credit consumption for gateway usage

**Deliverables:**
- Wallet-based authentication
- Turbo integration
- Unified credit system

### Phase 5: Advanced Features
**Duration: 2-4 weeks**

**Focus**: Polish and scale

- Webhooks for events
- TypeScript SDK
- Sandbox/test mode
- Advanced analytics
- Rate limit customization per org

**Deliverables:**
- Webhook system
- Official SDK
- Test environment

---

## Open Questions

### Resolved

| Question | Decision |
|----------|----------|
| **Email Provider** | Mailchimp Transactional |
| **Monitoring** | Prometheus + Honeycomb |
| **Database hosting** | Self-hosted PostgreSQL on AR.IO backend |
| **Redis hosting** | Self-hosted locally |
| **Dashboard** | Integrated into existing ar.io console (Arweave-hosted) |

### Still Open

1. **Branding**: What should the service be called? "AR.IO Gateway Auth"? "AR.IO Access"? "AR.IO Gateway API"?

2. **Pricing Tiers**: What are the plan names and quota limits?
   - Free: 1GB egress, 100k requests (proposed)
   - Starter: ?
   - Growth: ?
   - Enterprise: ?

3. **Domain**: What domain will the GAS API use? `api.ar.io`? `gateway-api.ar.io`?

4. **ar.io Console Integration**:
   - Does the console currently have user accounts?
   - If yes, how do we migrate/link existing users?
   - What auth does the console currently use?

5. **Turbo Integration Details**:
   - What's the Turbo API for credit balance lookup?
   - What's the API for credit consumption/deduction?
   - Is there a test/sandbox Turbo environment?

6. **Key Format**: Is `ario_<env>_<random>` acceptable or prefer different format?

7. **Credit Conversion Rate**: How many Turbo credits per GB of egress? Per 1000 requests?

8. **Free Tier Limits**: Are the proposed limits (1GB, 100k requests) appropriate?

9. **Rate Limits**: What should the default rate limit be per tier?
   - Free: 10 req/sec (proposed)
   - Paid: 100 req/sec? 1000 req/sec?

10. **Arweave Wallet Auth Priority**: Should "Sign in with Arweave" be Phase 1 or Phase 2?
    - Given the crypto-native audience, might be worth prioritizing

---

## Appendix A: Security Considerations

### JWT Security
- Use RS256 (RSA-SHA256) for asymmetric signing
- Public key can be exposed for verification by other services
- Short expiry (15 min) limits damage from token theft
- JTI (JWT ID) enables revocation checking

### API Key Security
- Argon2id hashing (memory-hard, resistant to GPU attacks)
- Key prefix stored separately for lookup without full scan
- Timing-safe comparison for validation
- Never logged or returned after creation

### Rate Limiting
- Auth endpoints heavily rate limited
- Exponential backoff on repeated failures
- Account lockout after excessive failures (configurable)

### Input Validation
- All inputs validated and sanitized
- SQL injection prevented by ORM parameterization
- XSS prevented by React's default escaping
- CSRF tokens for all state-changing operations

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **GAS** | Gateway Auth Service (this service) |
| **JWT** | JSON Web Token - self-contained access token |
| **OIDC** | OpenID Connect - OAuth 2.0 based identity layer |
| **SAML** | Security Assertion Markup Language - XML-based SSO |
| **SIWE** | Sign-In with Ethereum - wallet-based auth standard |
| **JIT** | Just-In-Time provisioning - creating accounts on first SSO login |
| **ACS** | Assertion Consumer Service - SAML callback endpoint |
| **IdP** | Identity Provider - the SSO server (Okta, Azure AD, etc.) |
| **SP** | Service Provider - our application (GAS) |
