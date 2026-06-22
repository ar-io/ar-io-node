# AR.IO Gateway ArNS Resolution — Technical Overview

**Status**: Draft. Supersedes the prior AO-era version (same path) in git history.

The AR.IO gateway resolves human-readable names like `ardrive.permaweb.nexus`
into Arweave transaction IDs that ultimately back the response body. Resolution
is **Solana-native**: every authoritative lookup is a read against the
AR.IO ANT program on a Solana cluster via `@ar.io/sdk`, with multiple cache
tiers and a peer-fallback strategy layered on top.

## Table of Contents

1. [Architecture](#architecture)
2. [Resolution Flow](#resolution-flow)
3. [Caching Tiers](#caching-tiers)
4. [Sandbox Domain Security](#sandbox-domain-security)
5. [Configuration Reference](#configuration-reference)
6. [Error Handling](#error-handling)
7. [Failure Modes](#failure-modes)

---

## Architecture

### Components

The resolution system lives under `src/resolution/` and `src/init/`:

- **`CompositeArNSResolver`** (`src/resolution/composite-arns-resolver.ts`)
  — the orchestrator. Runs an ordered list of underlying resolvers in
  parallel, returns the first successful resolution that meets the timeout,
  falls back to cached values when fresh resolution misses or errors.
- **`OnDemandArNSResolver`** (`src/resolution/on-demand-arns-resolver.ts`)
  — direct path. Reads the ArNS record from the ANT mint's PDA via
  `SolanaANTReadable` from `@ar.io/sdk`, fetches the latest record state
  from `@solana/kit`, applies undername lookups.
- **`TrustedGatewayArNSResolver`** (`src/resolution/trusted-gateway-arns-resolver.ts`)
  — peer path. Forwards the resolution request to one or more trusted
  AR.IO gateway peers, reads `X-ArNS-*` headers off the response.
- **`ArNSNamesCache`** (`src/resolution/arns-names-cache.ts`)
  — bulk-name registry cache. Periodically paginates through
  `SolanaARIOReadable.getArNSRecords()` and writes each `{name, antId,
  undernameLimit, type, startTimestamp, endTimestamp}` tuple to a
  KV store. Used as the first lookup before falling through to the
  per-name resolvers.

### Wiring

`src/init/resolvers.ts` constructs the resolver chain at process start:

1. `ArNSResolverType[]` is read from `ARNS_RESOLVER_PRIORITY_ORDER`
   (default `gateway,on-demand`).
2. Each entry maps to its concrete resolver class. Concrete instances are
   then wrapped in `CompositeArNSResolver` with its registry + resolution
   KV caches (Redis or in-memory `NodeKvStore`, controlled by
   `ARNS_CACHE_TYPE`).

The composite resolver is what `src/system.ts` injects into the request
pipeline. From the request handler's perspective, ArNS resolution is a
single async call returning a `NameResolution` shape.

---

## Resolution Flow

For a request to `ardrive.permaweb.nexus/some/path`:

1. **Name parse**. Envoy splits the host on the first `.`. `ardrive` is
   the ArNS root; anything before becomes undername segments. The root
   is validated against the regex in `src/lib/validation.ts`.
2. **Names-cache fast path** (`ArNSNamesCache.getCachedArNSBaseName`).
   Returns `{antId, undernameLimit, type, startTimestamp, endTimestamp}`
   for the root if the periodic hydrator has seen it. A miss falls
   through. A hit short-circuits the on-demand SDK call.
3. **Composite resolution**. `CompositeArNSResolver` races the priority
   list of resolvers against `ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS`.
   The first resolver to return a `resolvedId` wins.
   - **On-demand resolver**: uses the cached `antId` (or fetches it
     fresh from the network process) to build a `SolanaANTReadable`,
     calls `getRecord(undername)` to get the resolved tx id.
   - **Trusted-gateway resolver**: HTTP request to each configured
     peer; first 2xx with valid `X-ArNS-*` headers wins.
4. **Cached fallback**. If every fresh resolver misses or the timeout
   trips, return the resolution-cache entry (if any) instead of failing.
   Controlled by `ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS`.
5. **Sandbox redirect**. If the resolved tx id is requested at its
   canonical name (not its sandbox host), respond 302 to the sandbox
   host. See [Sandbox Domain Security](#sandbox-domain-security).

A successful resolution writes back to **two** caches:
- The resolution KV (per-(name + undername) → `{resolvedId, ttl, antId,
  resolvedAt, limit, index}`)
- The names KV (the base-name `{antId, undernameLimit, …}` payload),
  if it was a names-cache miss.

---

## Caching Tiers

| Tier | Backing store | Scope | Refresh strategy |
|---|---|---|---|
| **Names cache** | `KvArNSRegistryStore` over Redis or in-memory KV | All base names known to the network process | Hydrator paginates `getArNSRecords()` on `ARNS_NAMES_CACHE_TTL_SECONDS` cadence + on misses |
| **Resolution cache** | `KvArNSResolutionStore` over the same KV backing | Per-(name, undername) → `{resolvedId, antId, …}` | Refreshed on cache miss / on TTL expiry, fallback-on-empty controlled by `ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS` |
| **Debounce cache** | `KvDebounceStore` | Hydration scheduling | Coalesces concurrent miss-driven hydrations into a single SDK round trip |

The KV layer is chosen by `ARNS_CACHE_TYPE`:
- `node` (default): in-memory `NodeKvStore` with `ARNS_CACHE_MAX_KEYS` cap
- `redis`: `RedisKvStore` against the gateway's Redis service

Resolution TTL comes from the on-chain record itself (via the SDK), but
the gateway can override with `ARNS_RESOLVER_OVERRIDE_TTL_SECONDS` if
operators want a different cache horizon than the network process exposes.

---

## Sandbox Domain Security

Resolved transaction content is served from a **sandboxed subdomain** to
isolate cookies / localStorage between names. The sandbox host is derived
from the resolved tx id via a base32 encoding (see `src/lib/sandbox.ts`).

If a request lands at the canonical hostname and the resolved id maps to
a different sandbox host, the gateway issues a 302 redirect. This is
unchanged from the AO-era implementation — the security model doesn't
depend on the resolution backend.

---

## Configuration Reference

Defined in `src/config.ts`:

| Env var | Default | Purpose |
|---|---|---|
| `ARNS_RESOLVER_PRIORITY_ORDER` | `gateway,on-demand` | Ordered comma-separated list of resolver strategies |
| `ARNS_CACHE_TYPE` | `node` | `node` (in-memory) or `redis` |
| `ARNS_CACHE_TTL_SECONDS` | `86400` (24h) | Resolution-cache entry TTL |
| `ARNS_CACHE_MAX_KEYS` | `10000` | Node-cache eviction ceiling |
| `ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS` | `250` | Time to wait on fresh resolution before serving from cache |
| `ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS` | `3000` | Per-resolver time budget within the composite |
| `ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS` | `30000` | Final resolver gets a longer budget |
| `ARNS_NAMES_CACHE_TTL_SECONDS` | `3600` (1h) | Names-cache rehydration cadence |
| `ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS` | `120` | Throttle for miss-driven hydration |
| `ARNS_MAX_CONCURRENT_RESOLUTIONS` | `1` | Per-tick concurrency cap |
| `ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT` | `true` | When true, reject undernames past the ANT's `undernameLimit` |
| `ARNS_RESOLVER_OVERRIDE_TTL_SECONDS` | unset | Override SDK-provided TTL with a local value |
| `ARIO_ANT_PROGRAM_ID` | unset | Devnet/localnet program-id override for the ANT program |
| `ARIO_ARNS_PROGRAM_ID` | unset | Devnet/localnet program-id override for the ArNS registry program |

A few related Solana-RPC circuit-breaker knobs (also in `src/config.ts`):
`ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_{TIMEOUT,ERROR_THRESHOLD_PERCENTAGE,ROLLING_COUNT_TIMEOUT,RESET_TIMEOUT}_MS`.

---

## Error Handling

Every resolver call is wrapped in a tracing span and an error classifier:

- **Network process down** (Solana RPC unreachable, rate-limited 429, or
  the program returned a known "not-yet-initialized" error): the resolver
  records the failure on its OpenTelemetry span, returns `undefined`, and
  the composite resolver falls back to the cached resolution if one exists.
- **Not-found** (ANT mint PDA exists but the requested undername is not
  in the record): returns `undefined` from the resolver. Composite tries
  the next strategy in the priority order, then returns 404 if all miss.
- **Past undername limit** (when `ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT`
  is true): explicit failure surfaced to the caller as 404 — semantically
  invalid request, not a transient error.

Failures are also tracked in three Prometheus counters:
`arns_cached_resolution_fallback_on_empty_total`,
`arns_name_cache_hydration_failures_total`,
`arns_name_cache_hydration_retries_total`.

---

## Failure Modes

| Scenario | Behavior |
|---|---|
| Solana RPC timeout | Fresh resolution fails; cached value served if available; otherwise 404. Counter increments. |
| RPC 429 (rate-limited) | Same as timeout; the SDK retries with backoff once before failing up to the resolver. |
| Names-cache hydrator fails repeatedly | Hydrator backs off and retries; in-flight resolutions fall through to per-name on-demand lookups. Gauge `arns_base_name_cache_entries` may go stale. |
| ANT program-id misconfigured (`ARIO_ANT_PROGRAM_ID` pointing at the wrong cluster) | All lookups return "AccountNotInitialized"; resolutions miss; 404. Reconfigure operator. |
| Trusted-gateway peer returns malformed `X-ArNS-Ant-Id` | Resolver discards the header, treats as a 404 for that peer, tries the next. |

The classifier explicitly distinguishes **transient** (RPC, rate-limit,
timeouts) from **terminal** (not-found, over-limit) failures so the
composite resolver can apply the right fallback strategy.

---

*This document reflects the `solana` branch at SDK `4.0.0-solana.14`. For
the AO-era architecture, see git history prior to the AO sidecar removal.*
