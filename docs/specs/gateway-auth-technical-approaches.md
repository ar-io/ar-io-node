# Gateway Auth Service - Technical Approach Analysis

## Overview

This document analyzes different technical approaches for building the Gateway Auth Service (GAS), comparing build vs. buy tradeoffs, open source options, and third-party services.

---

## Approach Options Summary

| Approach | Monthly Cost (Est.) | Implementation Time | Operational Complexity | Flexibility |
|----------|---------------------|---------------------|------------------------|-------------|
| **A: 100% Custom Build** | $50-200 (infra only) | 12-16 weeks | Medium | Highest |
| **B: Ory Stack (Self-Hosted)** | $50-200 (infra only) | 8-12 weeks | Medium-High | High |
| **C: Keycloak/Authentik** | $100-300 (infra) | 6-10 weeks | High | Medium |
| **D: WorkOS (Managed)** | $125/SSO connection | 4-6 weeks | Low | Low |
| **E: Auth0 (Managed)** | $800+/month | 4-6 weeks | Low | Medium |
| **F: Hybrid (Custom + Ory)** | $50-200 (infra only) | 10-14 weeks | Medium | High |

---

## Approach A: 100% Custom Build

Build everything from scratch using Node.js/TypeScript with proven libraries.

### Tech Stack
- **Framework**: Fastify (high performance, TypeScript native)
- **JWT**: `jose` library (standards-compliant)
- **Password Hashing**: `argon2` (memory-hard, secure)
- **OAuth/OIDC**: `openid-client` library
- **SAML**: `@node-saml/node-saml` or `saml2-js`
- **Database**: PostgreSQL + Prisma ORM
- **Cache**: Redis

### Pros
- Complete control over every aspect
- No vendor lock-in
- No per-user or per-connection fees
- Exactly matches our requirements (no bloat)
- Can optimize for AR.IO Gateway specifically

### Cons
- Longest implementation time
- Must handle all security edge cases ourselves
- SAML implementation is notoriously complex
- Ongoing maintenance burden for security patches
- Need deep auth expertise on team

### Cost Breakdown
| Item | Monthly Cost |
|------|-------------|
| PostgreSQL (managed) | $15-50 |
| Redis (managed) | $15-50 |
| Compute (2-4 instances) | $20-100 |
| **Total** | **$50-200** |

### Recommended If
- Team has strong auth/security expertise
- Budget is constrained but timeline is flexible
- Need maximum customization for Arweave/crypto wallet integration

---

## Approach B: Ory Stack (Self-Hosted Open Source)

Use Ory's modular, cloud-native identity components.

### Components
- **Ory Kratos**: Identity management (registration, login, MFA, account recovery)
- **Ory Hydra**: OAuth 2.0 / OIDC server (for SSO)
- **Ory Oathkeeper**: API gateway / auth proxy (optional)
- **Custom Proxy**: Our metering/billing layer

### Architecture
```
Request → Custom GAS Proxy → Ory Oathkeeper → AR.IO Gateway
              ↓
         Ory Kratos (identity)
              ↓
         Ory Hydra (OAuth/OIDC)
```

### Pros
- Battle-tested at scale (OpenAI uses Ory for 800M+ weekly users)
- Written in Go (fast, low resource usage)
- API-first, headless (we build our own UI)
- Active open source community
- Modular - use only what we need
- Scales to billions of users

### Cons
- Learning curve for Ory's concepts
- Multiple services to orchestrate
- SAML requires Enterprise License (OEL) - contact for pricing
- Self-hosted means we handle upgrades/security patches
- <10% of self-hosted deployments run recent versions (per Ory telemetry)

### Cost Breakdown
| Item | Monthly Cost |
|------|-------------|
| PostgreSQL (managed) | $15-50 |
| Kratos + Hydra compute | $30-100 |
| Custom proxy compute | $20-50 |
| **Total (Open Source)** | **$65-200** |
| **Enterprise License** | Contact Ory (for SAML, SCIM) |

### Recommended If
- Need enterprise-grade auth without vendor lock-in
- Comfortable with self-hosting complexity
- Don't need SAML immediately (or willing to pay for OEL)

---

## Approach C: Keycloak or Authentik (Self-Hosted)

Deploy a full-featured identity server.

### Keycloak
- Java-based, Red Hat backed, CNCF incubating
- Full OIDC, SAML, LDAP support out of the box
- Heavy resource usage (JVM)
- Steep learning curve, complex administration
- Best for: Large enterprises with legacy integration needs

### Authentik
- Python-based, modern UI
- "Flow" system for custom auth journeys
- Lighter than Keycloak
- Growing community, less battle-tested
- Best for: SMBs wanting easier setup than Keycloak

### Pros
- Full-featured out of the box
- SAML included (no extra license)
- Rich admin UI
- Large communities

### Cons
- Monolithic - harder to customize specific behaviors
- Resource heavy (especially Keycloak)
- Must still build custom proxy for metering
- UI may not match our brand without significant work
- Overkill for our specific use case

### Cost Breakdown
| Item | Monthly Cost |
|------|-------------|
| PostgreSQL (managed) | $15-50 |
| Keycloak/Authentik compute (needs more RAM) | $50-150 |
| Custom proxy compute | $20-50 |
| **Total** | **$85-250** |

### Recommended If
- Need full SSO suite immediately including SAML
- Have ops team experienced with Java/Python identity servers
- Don't mind the heavier footprint

---

## Approach D: WorkOS (Managed Service)

Use WorkOS for enterprise SSO, build everything else custom.

### What WorkOS Provides
- Enterprise SSO (SAML + OIDC) to any IdP
- Directory Sync (SCIM)
- Admin Portal for customer self-service SSO setup
- Audit Logs

### What We Still Build
- User registration/login (email/password)
- API key management
- Organization/tenant management
- Usage metering & billing
- Dashboard UI
- Proxy layer

### Pros
- Enterprise SSO is the hardest part - WorkOS handles it
- Per-connection pricing is predictable
- Self-serve admin portal reduces our support burden
- SOC 2, GDPR compliant

### Cons
- $125/month per SSO connection adds up
  - 10 enterprise customers = $1,250/month
  - 50 enterprise customers = $6,250/month
  - 100 enterprise customers = $12,500/month
- Still need to build 70% of the system ourselves
- Vendor dependency for critical auth path
- No email/password auth (must build separately)

### Cost Breakdown (50 enterprise customers)
| Item | Monthly Cost |
|------|-------------|
| WorkOS (50 connections) | ~$5,000 (volume discount) |
| PostgreSQL (managed) | $15-50 |
| Redis (managed) | $15-50 |
| Custom service compute | $30-100 |
| **Total** | **~$5,100-5,200** |

### Recommended If
- Enterprise SSO is the primary requirement
- Want to minimize SSO implementation risk
- Can pass SSO costs to enterprise customers
- Have budget but limited auth expertise

---

## Approach E: Auth0 (Fully Managed)

Use Auth0 for complete authentication.

### What Auth0 Provides
- Email/password, social login
- Enterprise SSO (SAML, OIDC)
- MFA
- User management
- Rules/Actions for customization
- Pre-built UI components (Lock)

### What We Still Build
- API key management (Auth0 has M2M tokens but limited)
- Organization model (Auth0 Organizations exists but limited)
- Usage metering & billing
- Proxy layer
- Custom dashboard

### Pros
- Most comprehensive managed solution
- Handles security updates automatically
- Extensive compliance certifications
- Large ecosystem of integrations

### Cons
- **Expensive and unpredictable pricing**
  - B2B Professional: $800/month for 500 MAUs, only 5 SSO connections
  - 6th SSO connection forces Enterprise tier (~$30,000+/year)
  - Cost scales with MAUs, not connections
- Still need custom development for our specific needs
- Vendor lock-in (hard to migrate away)
- Overly complex for our use case

### Cost Breakdown
| Item | Monthly Cost |
|------|-------------|
| Auth0 B2B Professional (500 MAU) | $800 |
| Auth0 Enterprise (if >5 SSO) | ~$2,500+ |
| Custom service compute | $30-100 |
| **Total** | **$830-2,600+** |

### Recommended If
- Need fastest time to market
- Have significant budget
- Users/MAUs will stay relatively low
- Compliance certifications are critical immediately

---

## Approach F: Hybrid (Recommended)

Custom build with selective use of battle-tested libraries.

### Architecture
```
┌─────────────────────────────────────────────────────────────────┐
│                    Gateway Auth Service (GAS)                    │
│                      (Custom Node.js/Fastify)                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     Auth Module                           │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │  │
│  │  │ Email/Pass  │  │   OAuth     │  │    SAML     │      │  │
│  │  │  (custom)   │  │  (Arctic)   │  │ (node-saml) │      │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘      │  │
│  │  ┌─────────────┐  ┌─────────────┐                       │  │
│  │  │   Wallet    │  │   Session   │                       │  │
│  │  │   (SIWE)    │  │   (jose)    │                       │  │
│  │  └─────────────┘  └─────────────┘                       │  │
│  └──────────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │   Metering   │  │    Proxy     │  │   Dashboard  │        │
│  │   (custom)   │  │   (undici)   │  │ (React+Vite) │        │
│  └──────────────┘  └──────────────┘  └──────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

### Key Libraries
| Function | Library | License | Maturity |
|----------|---------|---------|----------|
| HTTP Framework | Fastify | MIT | Production-ready |
| JWT/JWE/JWS | jose | MIT | Production-ready |
| OAuth 2.0 Client | Arctic (50+ providers) | MIT | Active |
| SAML 2.0 | @node-saml/node-saml | MIT | Mature |
| Password Hashing | argon2 | MIT | Industry standard |
| Ethereum Auth | siwe | Apache-2.0 | Production-ready |
| ArConnect | arweave-wallet-connector | MIT | Active |
| ORM | Prisma | Apache-2.0 | Production-ready |
| Validation | Zod | MIT | Production-ready |
| Email | Nodemailer + templates | MIT | Mature |

### Implementation Order

**Phase 1 (4-6 weeks): Core Auth**
- Email/password registration & login
- JWT access tokens + refresh tokens
- API key management
- Basic organization model
- Gateway proxy with metering
- Minimal dashboard

**Phase 2 (3-4 weeks): OAuth SSO**
- Google, GitHub, Microsoft OAuth via Arctic
- OIDC provider support
- JIT user provisioning

**Phase 3 (3-4 weeks): Enterprise SSO**
- SAML 2.0 via node-saml
- Per-org IdP configuration
- SP metadata generation

**Phase 4 (2-3 weeks): Wallet Auth**
- Ethereum via SIWE
- Arweave via ArConnect
- Wallet linking to accounts

**Phase 5 (2-3 weeks): Polish**
- Full dashboard UI
- Email notifications
- Audit log viewer
- Usage analytics

### Pros
- Full control, no vendor lock-in
- No per-user or per-connection fees
- Uses proven libraries for complex parts (SAML, OAuth)
- Optimized for our exact requirements
- Easy to add Arweave-specific features
- Can be open-sourced for community benefit

### Cons
- More development time than fully managed
- Must handle security patches for dependencies
- Need to build dashboard UI from scratch
- SAML testing requires IdP sandboxes

### Cost Breakdown (AR.IO Infrastructure)

Based on AR.IO's infrastructure decisions:

| Item | Hosting | Monthly Cost |
|------|---------|-------------|
| PostgreSQL | Self-hosted on AR.IO backend | $0 (existing infra) |
| Redis | Self-hosted locally | $0 (existing infra) |
| Compute (GAS service) | AR.IO backend | $20-100 |
| Email (Mailchimp Transactional) | Managed | $0-20 |
| Monitoring (Prometheus + Honeycomb) | Self-hosted + managed | $0-50 |
| **Total incremental cost** | | **$20-170** |

### Infrastructure Decisions

| Component | Decision | Notes |
|-----------|----------|-------|
| **PostgreSQL** | Self-hosted on AR.IO backend | Co-located with GAS service |
| **Redis** | Self-hosted locally | For sessions, rate limits, real-time counters |
| **Email** | Mailchimp Transactional | For verification, password reset, notifications |
| **Monitoring** | Prometheus + Honeycomb | Metrics + distributed tracing |
| **Dashboard** | Integrated into ar.io console | Existing Arweave-hosted app |

### Third-Party Services Required

| Service | Purpose | Estimated Cost |
|---------|---------|----------------|
| **Mailchimp Transactional** | Email delivery | Free up to 500/day, then ~$20/month |
| **Honeycomb** | Distributed tracing | Free tier available, ~$50/month for production |

---

## Recommendation

**Approach F (Hybrid Custom Build)** is recommended for the following reasons:

### Why Not Managed Services (Auth0, WorkOS)?
1. **Cost at scale**: Enterprise SSO pricing punishes growth
   - 100 enterprise customers on WorkOS = $12,500/month
   - Same on Auth0 could be $30,000+/year minimum
2. **Vendor lock-in**: Hard to migrate once integrated
3. **Still need custom work**: Metering, billing, API keys, dashboard

### Why Not Full Open Source (Keycloak, Authentik)?
1. **Overkill**: These are full identity servers; we need a proxy with auth
2. **Resource heavy**: Keycloak needs significant memory
3. **Operational burden**: Managing Java/Python identity servers
4. **UI mismatch**: Would need significant customization

### Why Not Ory (Self-Hosted)?
1. **SAML requires paid license**: Enterprise License needed for SAML/SCIM
2. **Complexity**: Multiple services to orchestrate (Kratos + Hydra + Oathkeeper)
3. **Learning curve**: Ory has its own concepts and patterns
4. **Close consideration**: If SAML wasn't needed, Ory would be strong choice

### Why Hybrid Custom?
1. **Right-sized**: Build exactly what we need, nothing more
2. **Cost-effective**: ~$100-200/month in infrastructure vs. thousands for managed
3. **Proven libraries**: SAML, OAuth, JWT libraries are mature
4. **Flexibility**: Easy to add Arweave wallet auth, Turbo integration
5. **Open source potential**: Could release for AR.IO community
6. **Team growth**: Builds internal auth expertise

### Trade-off Acknowledgment
- **Higher initial investment** (12-16 weeks vs. 4-6 weeks)
- **Ongoing maintenance** (security patches, dependency updates)
- **Requires auth expertise** (or willingness to develop it)

If timeline is critical and budget allows, **WorkOS for SSO only + custom for everything else** is a reasonable middle ground.

---

## Next Steps

1. **Validate recommendation** with team
2. **Spike on SAML implementation** (1-2 days) to validate node-saml complexity
3. **Set up infrastructure** (PostgreSQL, Redis, compute)
4. **Begin Phase 1 implementation**

---

## Sources

### Open Source Auth
- [Open Source Auth Providers 2025 - Tesseral](https://tesseral.com/guides/open-source-auth-providers-in-2025-best-solutions-for-open-source-auth)
- [Keycloak Alternatives - Osohq](https://www.osohq.com/learn/best-keycloak-alternatives-2025)
- [Open Source Identity 2025 - HouseOfFoss](https://www.houseoffoss.com/post/the-state-of-open-source-identity-in-2025-authentik-vs-authelia-vs-keycloak-vs-zitadel)
- [Ory Kratos - GitHub](https://github.com/ory/kratos)
- [Ory Pricing](https://www.ory.com/pricing)

### Managed Services
- [WorkOS vs Auth0 vs Clerk](https://workos.com/blog/workos-vs-auth0-vs-clerk)
- [WorkOS Alternatives - SuperTokens](https://supertokens.com/blog/workos-alternatives)
- [Auth0 Alternatives - Scalekit](https://www.scalekit.com/compare/auth0-alternatives)

### API Gateways
- [API Gateway Comparison - API7](https://api7.ai/learning-center/api-gateway-guide/api-gateway-comparison-apisix-kong-traefik-krakend-tyk)
- [Top 10 API Gateways 2025 - Nordic APIs](https://nordicapis.com/top-10-api-gateways-in-2025/)

### Libraries
- [Lucia Auth](https://lucia-auth.com/)
- [Arctic OAuth Library](https://arcticjs.dev/)
- [node-saml](https://github.com/node-saml/node-saml)
- [jose JWT Library](https://github.com/panva/jose)
- [SIWE - Sign-In with Ethereum](https://docs.login.xyz/)

---

## Selected Approach

**Decision**: Approach F (Hybrid Custom Build) with AR.IO infrastructure.

### Final Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   ar.io Console (Arweave-hosted)                │
│               Dashboard UI integrated into existing app          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Gateway Auth Service (GAS)                    │
│                      (Node.js/Fastify Backend)                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │   Auth      │  │   Metering  │  │   Proxy     │             │
│  │  (Arctic,   │  │  (Custom)   │  │  (undici)   │             │
│  │  node-saml, │  │             │  │             │             │
│  │  jose)      │  │             │  │             │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              AR.IO Backend Infrastructure                │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │   │
│  │  │  PostgreSQL │  │    Redis    │  │   Prometheus    │  │   │
│  │  │(self-hosted)│  │(self-hosted)│  │  + Honeycomb    │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     AR.IO Gateway Cluster                        │
│                   (existing ar-io-node instances)                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  Mailchimp      │
                    │  Transactional  │
                    │  (Email)        │
                    └─────────────────┘
```

### Key Decisions Summary

| Component | Technology | Hosting |
|-----------|------------|---------|
| Backend Framework | Fastify (Node.js) | AR.IO Backend |
| Database | PostgreSQL | Self-hosted |
| Cache | Redis | Self-hosted |
| OAuth | Arctic library | - |
| SAML | node-saml | - |
| JWT | jose | - |
| Email | Mailchimp Transactional | Managed |
| Metrics | Prometheus | Self-hosted |
| Tracing | Honeycomb | Managed |
| Dashboard | ar.io console | Arweave |

### Estimated Timeline

| Phase | Duration | Key Deliverables |
|-------|----------|------------------|
| Phase 1: Core Auth | 4-6 weeks | GitHub OAuth, API keys, metering, OpenAPI docs |
| Phase 2: DX & Social | 3-4 weeks | Google OAuth, code examples, usage dashboard |
| Phase 3: Enterprise | 4-6 weeks | Multi-org, OIDC, SAML, team management |
| Phase 4: Arweave | 3-4 weeks | Wallet auth, Turbo integration |
| Phase 5: Advanced | 2-4 weeks | Webhooks, SDK, sandbox mode |
| **Total** | **16-24 weeks** | Full-featured auth service |
