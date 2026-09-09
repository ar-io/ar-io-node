# IPFS Integration

This document describes the AR.IO Gateway's IPFS CID serving capability,
covering architecture, request flow, configuration, and deployment.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [URL Patterns](#url-patterns)
- [Components](#components)
- [Data Flow](#data-flow)
- [Caching Strategy](#caching-strategy)
- [Security and Moderation](#security-and-moderation)
- [Docker Deployment](#docker-deployment)
- [Configuration Reference](#configuration-reference)
- [Phase 2: ArNS to IPFS Resolution](#phase-2-arns-to-ipfs-resolution)
- [Differences from Arweave Data Serving](#differences-from-arweave-data-serving)
- [Observability](#observability)

## Overview

### What This Feature Does

The IPFS integration allows an AR.IO Gateway to serve IPFS content alongside
Arweave data. A local Kubo IPFS node runs as a Docker sidecar, and the gateway
proxies, caches, and moderates requests to it. This gives gateway operators a
single endpoint for both permanent Arweave data and IPFS-addressed content.

### Why It Exists

The Arweave Name System (ArNS) maps human-readable names to content addresses.
Today those addresses are Arweave transaction IDs. Adding IPFS CID support
means ArNS names can also point to IPFS content, bridging the two largest
decentralized storage networks under one naming layer without requiring changes
to the ArNS smart contract. Users get a single URL (e.g.,
`my-app.arweave.dev/`) regardless of whether the underlying data lives on
Arweave or IPFS.

### Phased Approach

**Phase 1 -- Direct CID Access (current):** Users access IPFS content by
placing a CID in the URL path or subdomain. The gateway validates, rate-limits,
and caches the request, then proxies it to the local Kubo node. No ArNS
resolution is involved.

**Phase 2 -- ArNS to CID Resolution (implemented):** ANT (Arweave Name Token)
records carry a `targetProtocol` field (`0` = Arweave, `1` = IPFS) and the
content target may be an IPFS CID. When the gateway resolves an ArNS name whose
record targets IPFS, it routes the request to the IPFS service instead of the
Arweave data pipeline. See
[Phase 2: ArNS to IPFS Resolution](#phase-2-arns-to-ipfs-resolution) for the
full flow, headers, and caching semantics.

## Architecture

### Request Flow Diagram

```
                        +-----------+
                        |  Client   |
                        +-----+-----+
                              |
              path: /ipfs/{CID}   -or-   subdomain: {CID}.ipfs.gateway.io
                              |
                              v
                   +----------+-----------+
                   |   Express Router /   |
                   |   IPFS Middleware    |
                   +----------+-----------+
                              |
                   1. CID validation
                              |
                              v
                   +----------+-----------+
                   |   IPFS Blocklist     |
                   |   (451 if blocked)   |
                   +----------+-----------+
                              |
                              v
                   +----------+-----------+
                   |   IPFS Rate Limiter  |
                   |   (429 if exceeded)  |
                   +----------+-----------+
                              |
                              v
                   +----------+-----------+
                   |   IPFS Cache         |
                   |   (LRU filesystem)   |
                   +----+----------+------+
                        |          |
                   cache hit   cache miss
                        |          |
                        v          v
                   +--------+  +--+------------------+
                   |  Serve |  |  Kubo Data Source    |
                   |  from  |  |  (HTTP fetch with   |
                   | cache  |  |   timeouts)          |
                   +--------+  +--+------------------+
                                  |
                           tee stream to
                           cache + response
                                  |
                                  v
                            +-----+------+
                            |  Response  |
                            |  (headers, |
                            |   stream)  |
                            +------------+
```

### Component Relationships

```
src/system.ts
  |
  +-- ipfs-service ----+-- kubo-data-source  --> Kubo HTTP Gateway (sidecar)
  |                    +-- ipfs-cache         --> data/ipfs-cache/
  |                    +-- ipfs-blocklist     --> data/ipfs-blocklist.txt
  |                    +-- ipfs-rate-limiter  --> token bucket (memory or Redis)
  |
  +-- middleware/ipfs   (subdomain interception)
  +-- routes/ipfs       (path-based handlers)
```

## URL Patterns

### Path-Based Access

| Pattern | Example | Description |
|---------|---------|-------------|
| `/ipfs/{CID}` | `/ipfs/QmYwAPJzv5CZ...` | Fetch a single file or directory root |
| `/ipfs/{CID}/{path}` | `/ipfs/bafybeig.../images/logo.png` | Fetch a file within a UnixFS directory |

### Subdomain-Based Access

| Pattern | Example | Description |
|---------|---------|-------------|
| `{CID}.{root_host}` | `bafybeig...arweave.dev` | CIDv1 (base32) in subdomain |
| `{CID}.{root_host}/{path}` | `bafybeig...arweave.dev/index.html` | Subdomain with path |

Subdomain-based access uses the `ARNS_ROOT_HOST` configuration. The `.ipfs.`
label in the hostname distinguishes IPFS requests from ArNS name resolution,
preventing collisions. For example, `my-app.arweave.dev` resolves as an ArNS
name, while `bafybeig...arweave.dev` resolves as an IPFS CID.

### Path-style origin isolation (and CIDv0 → CIDv1)

A path-style `/ipfs/{CID}` request is redirected (302) to the per-CID sandbox
subdomain `{CIDv1base32}.{root_host}`, giving each CID its own browser origin —
the same isolation the Arweave data path gets for `/{txid}` via the sandbox
middleware. This prevents one CID's HTML/JS from executing in the shared gateway
origin. The redirect is skipped when the request already arrived on that
subdomain (no loop), and ArNS-served IPFS is already isolated on the name's own
origin (so it reaches the handler directly, not this route).

CIDv0 identifiers (base58, starting with `Qm`) are case-sensitive and cannot be
used in subdomains, so they are normalized to their DNS-safe CIDv1 base32 form as
part of the same redirect. Requests already on the correct `{CID}.{root_host}`
subdomain are served directly.

## Components

### `src/lib/ipfs-cid.ts` -- CID Parsing and Conversion

Utility module for working with IPFS Content Identifiers:

- **CID validation**: Determines whether a string is a valid CIDv0 or CIDv1.
- **CID conversion**: Converts CIDv0 (base58btc) to CIDv1 (base32) for
  subdomain compatibility.
- **CID normalization**: Produces a canonical form used as cache keys and
  blocklist entries.

### `src/ipfs/kubo-data-source.ts` -- Kubo HTTP Client

Fetches content from the local Kubo IPFS gateway over HTTP:

- **Connection timeout** (`IPFS_KUBO_REQUEST_TIMEOUT_MS`): Maximum time to
  receive response headers from Kubo. Covers DNS, TCP, and TLS handshake plus
  time-to-first-byte.
- **Stall timeout** (`IPFS_STREAM_STALL_TIMEOUT_MS`): Maximum idle time during
  body streaming. The timer resets on each received chunk, so large but
  actively-streaming transfers complete without issue. If no data arrives for
  this duration, the stream is aborted.
- Returns a readable stream along with response metadata (content type, content
  length).

### `src/ipfs/ipfs-cache.ts` -- Bounded LRU Filesystem Cache

A filesystem-backed cache separate from the Arweave contiguous data cache:

- **Cache directory**: Configurable via `IPFS_CACHE_PATH` (default:
  `data/ipfs-cache`).
- **Size limit**: Bounded by `IPFS_CACHE_MAX_SIZE_BYTES` (default: 10 GB). When
  the limit is exceeded, the least recently used entries are evicted.
- **Cache key**: SHA-256 hash of the normalized CID concatenated with the
  request path. This ensures consistent keys regardless of CID encoding.
- **Metadata**: Each cached entry has a companion `.meta` file storing content
  type, content length, and the original CID. Metadata is read on cache hits to
  set response headers without re-parsing the content.
- **Cleanup threshold**: `IPFS_CACHE_CLEANUP_THRESHOLD` controls how often (in
  seconds) eviction scans run.

### `src/ipfs/ipfs-blocklist.ts` -- CID Blocklist

A file-based blocklist for content moderation:

- **Format**: Plain text file, one CID per line. Lines starting with `#` are
  treated as comments. Both CIDv0 and CIDv1 forms are normalized before
  matching.
- **Hot-reload**: The blocklist file is watched for changes using filesystem
  notifications. Additions and removals take effect without restarting the
  gateway.
- **Response**: Blocked CIDs return HTTP 451 (Unavailable For Legal Reasons).
- **Block by content hash too**: moderation uses the same admin API and store as
  Arweave (`isIdBlocked` on the CID, and `isHashBlocked` on the served bytes'
  base64url SHA-256). Because the SHA-256 is known once content is cached, a
  block-by-content-hash entry stops an IPFS CID serving those same bytes, not
  only a block-by-CID — matching the Arweave data path.

### `src/ipfs/ipfs-rate-limiter.ts` -- Rate Limiter

A dedicated token bucket rate limiter for IPFS traffic, separate from the
Arweave rate limiter:

- **Per-IP bucket**: Controls how much a single client can fetch
  (`IPFS_RATE_LIMITER_IP_TOKENS_PER_BUCKET`,
  `IPFS_RATE_LIMITER_IP_REFILL_PER_SEC`).
- **Per-resource bucket**: Controls how much a single CID can be served
  globally (`IPFS_RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET`,
  `IPFS_RATE_LIMITER_RESOURCE_REFILL_PER_SEC`).
- Tokens represent bytes (1 token = 1 byte). Bucket sizes and refill rates are
  configurable independently from the Arweave rate limiter.
- When limits are exceeded, the gateway returns HTTP 429 (Too Many Requests).

### `src/ipfs/ipfs-service.ts` -- Service Orchestrator

Coordinates all IPFS components behind a single interface:

- Accepts a CID and optional path, runs it through the blocklist, rate limiter,
  and cache, and falls back to the Kubo data source on cache miss.
- Handles stream teeing: on a cache miss, the Kubo response stream is split so
  one branch writes to cache while the other streams to the client.
- Enforces `IPFS_MAX_RESPONSE_SIZE_BYTES` to prevent serving excessively large
  files.
- Registered in `src/system.ts` alongside other data services, guarded by the
  `IPFS_ENABLED` flag.

### `src/middleware/ipfs.ts` -- Subdomain Middleware

Express middleware that intercepts requests based on the `Host` header:

- Parses the hostname to detect the `{CID}.{root_host}` pattern.
- Extracts the CID and any path from the URL.
- Performs CIDv0 to CIDv1 redirect when necessary.
- Forwards the extracted CID and path to the IPFS route handler.
- Must run before the ArNS subdomain middleware to prevent the CID from being
  misinterpreted as an ArNS name.

### `src/routes/ipfs.ts` -- Route Handlers

Express route handlers for path-based IPFS access:

- `GET` and `HEAD` `/ipfs/:cid` and `/ipfs/:cid/*` routes.
- Validates the CID parameter, delegates to the IPFS service, and streams the
  response with appropriate headers. `HEAD` returns the full header set with no
  body (and bills zero egress).
- Sets `Cache-Control`, `ETag`, `X-Ipfs-Path`, and `Accept-Ranges: bytes`. A
  client `Range` header is forwarded to Kubo and relayed as `206 Partial
  Content` + `Content-Range`; an unsatisfiable range returns `416`. Partial
  (206) responses are streamed straight from Kubo and are never cached.

## Data Flow

The complete lifecycle of an IPFS request:

1. **Request arrives.** Either path-based (`/ipfs/{CID}/path`) or
   subdomain-based (`{CID}.ipfs.gateway.io/path`). Subdomain requests are
   detected by the IPFS middleware and rewritten internally to match the
   path-based route.

2. **CID validation.** The CID string is parsed. If it is not a valid CIDv0 or
   CIDv1, the request returns 400 (Bad Request). If it is a CIDv0 in a
   subdomain context, a 301 redirect is issued to the CIDv1 equivalent.

3. **Blocklist check.** The normalized CID is checked against the in-memory
   blocklist. If matched, the request returns 451 (Unavailable For Legal
   Reasons) immediately.

4. **Rate limit check.** Both the per-IP and per-resource buckets are checked.
   If either bucket is exhausted, the request returns 429 (Too Many Requests)
   with a `Retry-After` header.

5. **Cache lookup.** The cache key (SHA-256 of normalized CID + path) is looked
   up in the filesystem cache. On a hit, the cached file and its `.meta`
   companion are read and streamed to the client.

6. **Kubo fetch.** On a cache miss, the service makes an HTTP GET to the local
   Kubo gateway (`IPFS_KUBO_URL/ipfs/{CID}/{path}`). The response stream is
   tee'd: one branch writes to the cache directory, the other streams directly
   to the client. Both the connection timeout and the stall timeout apply during
   this phase.

7. **Response.** The following headers are set on successful responses:

   | Header | Value | Purpose |
   |--------|-------|---------|
   | `Cache-Control` | `public, max-age=31536000, immutable` (direct CID) / ArNS TTL (via a name) | CID content never changes; a name→CID binding is mutable |
   | `ETag` | `"{CID}"` | Content-addressed deduplication |
   | `X-Ipfs-Path` | `/ipfs/{CID}/{path}` | IPFS ecosystem interop |
   | `Content-Type` | Detected by Kubo or from `.meta` | Standard MIME typing |
   | `Accept-Ranges` | `bytes` | Advertises Range support; a `Range` request yields `206` + `Content-Range` |
   | `Content-Digest` | RFC 9530 SHA-256 (cache hits / HEAD) | Signed body binding when the hash is known |

## Caching Strategy

IPFS content is **content-addressed**: a given CID always maps to the same
bytes. This makes cached entries permanently valid -- there is no stale data and
no revalidation needed.

### Cache Properties

| Property | Details |
|----------|---------|
| **Location** | `IPFS_CACHE_PATH` (default `data/ipfs-cache`), separate from Arweave data |
| **Key** | SHA-256 hash of normalized CID concatenated with request path |
| **Eviction** | LRU (least recently used) when total size exceeds `IPFS_CACHE_MAX_SIZE_BYTES` |
| **Max size** | `IPFS_CACHE_MAX_SIZE_BYTES` (default 10 GB) |
| **Metadata** | Companion `.meta` JSON files store content type, size, and original CID |
| **Cleanup** | Eviction scans run every `IPFS_CACHE_CLEANUP_THRESHOLD` seconds (default 3600) |
| **Permanence** | No TTL-based expiration; entries are valid forever unless evicted for space |
| **Negative cache** | Absent/unpinned CIDs are recorded (shared `NegativeDataCache`, count+duration thresholds) so repeat requests short-circuit instead of re-hitting Kubo — as for absent Arweave ids. `404` responses also carry `Cache-Control` (`CACHE_NOT_FOUND_MAX_AGE`, `must-revalidate`). |

### Why a Separate Cache

The Arweave contiguous data cache is archival in nature -- operators configure
it to retain as much data as possible, potentially without eviction. IPFS
content has different retention characteristics: it requires pinning to persist
on the IPFS network, and gateway operators may not want unbounded IPFS storage.
A separate bounded LRU cache gives operators independent control over Arweave
and IPFS storage budgets.

## Security and Moderation

### Content Moderation

IPFS content moderation uses the same admin API as Arweave data moderation.
Block a CID using the existing endpoint:

```bash
curl -X PUT http://localhost:4000/ar-io/admin/block-data \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"id": "bafkreigbk3hjz6oyiywqf7eknthwc2osvt5xi6b6igwljn2qrxkthqgrp4", "source": "manual", "notes": "Reason for block"}'
```

- Pass the CIDv1 base32 string as the `id` field (same field used for Arweave TX IDs).
- Blocked requests return HTTP 451 (Unavailable for Legal Reasons).
- One unified moderation system for all content (Arweave and IPFS).

### Rate Limiting

IPFS rate limiting uses a separate token pool from the Arweave rate limiter.
This prevents IPFS traffic from consuming Arweave rate limit capacity and gives
operators independent tuning for each protocol.

- **Per-IP limits** prevent a single client from monopolizing bandwidth.
- **Per-resource limits** prevent a single popular CID from consuming all
  available throughput.
- Token counts represent bytes of data served.

### Size Limits

`IPFS_MAX_RESPONSE_SIZE_BYTES` (default 1 GB) caps the maximum size of a single
IPFS response. Requests for content exceeding this limit are rejected. This
protects the gateway from serving unexpectedly large files that could exhaust
memory or disk.

### Subdomain Isolation

Subdomain-based access (`{CID}.ipfs.gateway.io`) provides browser origin
isolation. Each CID gets its own origin, preventing cross-content scripting
attacks. This follows the same security model used by IPFS gateways and the
existing ArNS subdomain sandboxing in the AR.IO Gateway.

## Docker Deployment

IPFS runs as an opt-in Docker Compose profile. Enabling it starts a Kubo sidecar
alongside the core gateway services.

### Docker Compose Profile

The `ipfs` profile adds a Kubo container:

```yaml
services:
  kubo:
    image: ipfs/kubo:latest
    profiles:
      - ipfs
    ports:
      - "4001:4001"       # Swarm (libp2p) - public, for peer connections
    expose:
      - "5001"            # API - internal only, not exposed to host
      - "8080"            # Gateway - internal only, used by ar-io-node
    volumes:
      - ipfs-data:/data/ipfs
    environment:
      - IPFS_PROFILE=server
    command: ["daemon", "--enable-gc"]
```

### Port Reference

| Port | Protocol | Exposure | Purpose |
|------|----------|----------|---------|
| 4001 | TCP/UDP | Public | libp2p swarm -- peer discovery and content exchange |
| 5001 | HTTP | Internal | Kubo API -- used for pinning and node management |
| 8080 | HTTP | Internal | Kubo HTTP Gateway -- used by `kubo-data-source` to fetch content |

### Volume

The `ipfs-data` volume persists the Kubo datastore (block storage, peer
identity, configuration). This volume is independent of the gateway's `data/`
directory.

### Enabling IPFS

Start the gateway with the IPFS profile:

```bash
docker compose --profile ipfs up -d
```

Or set `IPFS_ENABLED=true` in your `.env` and include `ipfs` in your active
profiles.

### Garbage Collection

The Kubo container starts with `--enable-gc`, which periodically removes
unpinned blocks from the local IPFS datastore. This prevents unbounded growth
of the Kubo volume. Content actively being served is protected from GC.

## Configuration Reference

All environment variables are opt-in. The feature is disabled by default.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `IPFS_ENABLED` | Boolean | `false` | Master switch for IPFS support. When false, IPFS routes are not registered and the Kubo sidecar is not required. |
| `IPFS_KUBO_URL` | String | `http://kubo:8080` | Base URL of the local Kubo HTTP Gateway. In Docker, this is the container name. For local development, use `http://localhost:8080`. |
| `IPFS_KUBO_REQUEST_TIMEOUT_MS` | Number | `30000` | Connection timeout in milliseconds for Kubo requests (time to receive response headers). |
| `IPFS_STREAM_STALL_TIMEOUT_MS` | Number | `30000` | Stall timeout in milliseconds for streaming responses from Kubo. Stream is aborted if no data is received for this duration. Actively-streaming transfers are not affected. |
| `IPFS_KUBO_MAX_CONCURRENT_REQUESTS` | Number | `100` | Maximum concurrent in-flight fetches to Kubo. Bounds upstream/DHT amplification from cheap-to-issue requests (HEAD, tiny Range) that force a fetch before rate limiting is evaluated; requests over the cap fail fast with `502`. `0` disables the cap. |
| `IPFS_KUBO_API_URL` | String | `http://kubo:5001` | Kubo **RPC API** base (distinct from the read-only gateway on 8080). Used only for pinning. The RPC API is powerful — keep it internal to the sidecar, never exposed to the host/internet. |
| `IPFS_PIN_ARNS_CONTENT` | Boolean | `false` | Pin the CIDs that ArNS names resolve to, so named content this gateway serves stays retrievable in read-only mode instead of being GC'd by Kubo. |
| `IPFS_PIN_MAX` | Number | `10000` | Max distinct CIDs the pinner holds this process; oldest are unpinned (FIFO) beyond this to bound local storage. |
| `IPFS_RATE_LIMIT_UNKNOWN_SIZE_BYTES` | Number | `262144` | Rate-limit reserve for a response whose size Kubo doesn't declare up front (CAR / chunked). The full `IPFS_MAX_RESPONSE_SIZE_BYTES` would exceed the token buckets and reject every such request; actual bytes are still bounded mid-stream by `IPFS_MAX_RESPONSE_SIZE_BYTES`. |
| `IPFS_CACHE_PATH` | String | `data/ipfs-cache` | Directory for the IPFS filesystem cache. Relative paths are resolved from the gateway's working directory. |
| `IPFS_CACHE_MAX_SIZE_BYTES` | Number | `10737418240` (10 GB) | Maximum total size of the IPFS cache directory. LRU eviction begins when this limit is exceeded. |
| `IPFS_CACHE_CLEANUP_THRESHOLD` | Number | `3600` | Interval in seconds between cache eviction scans. |
| `IPFS_BLOCKLIST_PATH` | String | `data/ipfs-blocklist.txt` | Path to the CID blocklist file. The file is watched for changes and reloaded automatically. |
| `IPFS_RATE_LIMITER_IP_TOKENS_PER_BUCKET` | Number | `100000` | Maximum tokens (bytes) per IP bucket. |
| `IPFS_RATE_LIMITER_IP_REFILL_PER_SEC` | Number | `20` | Tokens added to each IP bucket per second. |
| `IPFS_RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET` | Number | `1000000` | Maximum tokens (bytes) per resource (CID) bucket. |
| `IPFS_RATE_LIMITER_RESOURCE_REFILL_PER_SEC` | Number | `100` | Tokens added to each resource bucket per second. |
| `IPFS_MAX_RESPONSE_SIZE_BYTES` | Number | `1073741824` (1 GB) | Maximum response size for a single IPFS request. Requests exceeding this are rejected. |

## Phase 2: ArNS to IPFS Resolution

Phase 2 connects ArNS naming to IPFS content, allowing `my-dapp.arweave.dev` to
serve IPFS-hosted content without the user needing to know the CID.

### How It Works

1. **ANT record targets a CID with `targetProtocol: ipfs`.** ANT records carry
   a `targetProtocol` field (`0` = Arweave, `1` = IPFS, default `0`) alongside
   the content target. An ANT owner (or controller) sets the target to an IPFS
   CID and `targetProtocol` to `1` -- e.g. via the AR.IO SDK:
   `ant.setUndernameRecord({ undername: 'ipfs', transactionId: '<CID>', ttlSeconds: 300, targetProtocol: 1 })`.

2. **The on-demand resolver reads `targetProtocol`.** `OnDemandArNSResolver`
   reads the record's `targetProtocol`. When it is IPFS, it validates the target
   as a CID (`isValidCid`) rather than as a 43-char Arweave ID, and surfaces
   `protocol: 'ipfs'` on the resolution (carried through the resolution cache).

3. **The ArNS middleware routes by protocol.** When `protocol === 'ipfs'` and
   IPFS serving is enabled, the middleware sets `ipfsCid`/`ipfsPath` on the
   request and hands off to the same IPFS handler used by the path/subdomain
   routes -- otherwise it serves via the Arweave data path as before.

4. **The IPFS service serves it.** Blocklist -> rate limit -> cache -> Kubo
   fetch, exactly as for a direct `/ipfs/{CID}` request.

The response carries the full ArNS envelope (`X-ArNS-Name`, `X-ArNS-Resolved-Id`
= the CID, `X-ArNS-Ant-Id`, `X-ArNS-TTL-Seconds`) plus `X-ArNS-Protocol: ipfs`,
`X-Ar-Io-Source: ipfs`, `X-Ipfs-Path`, and `ETag` = the CID. HTTPSIG signs the
ArNS binding headers and the IPFS serving headers (and `Content-Digest` on cache
hits), so the name->CID binding and the served bytes are both attested.

### Key Design Decisions

- **Explicit `targetProtocol`, not shape-sniffing.** Protocol comes from the
  ANT record's `targetProtocol` field, so an Arweave TX ID and an IPFS CID are
  never confused by guessing from string shape.
- **Mutable-binding cache semantics.** A direct `/ipfs/{CID}` request is cached
  `immutable` (content-addressed). But an ArNS name -> CID binding is **mutable**
  (the record can be repointed), so ArNS-served IPFS responses use the ArNS TTL
  for `Cache-Control`, not `immutable` -- a record update is never pinned in
  caches for ~a year (cf. PE-9072).
- **Transparent to users.** A user visiting `my-dapp.arweave.dev` does not need
  to know whether the content is on Arweave or IPFS; the URL is identical.
- **Owner/controller-controlled.** Switching a name between Arweave and IPFS is
  a single ANT record update (target + `targetProtocol`).
- **Caching and moderation apply.** All Phase 1 protections (blocklist, rate
  limits, cache) apply to ArNS-resolved IPFS content.
- **Resolver scope.** Protocol propagates across resolvers, including a
  trusted-gateway hop: the trusted-gateway resolver reads the signed
  `X-ArNS-Protocol` header and validates the resolved id per protocol (a CID for
  `ipfs`, a 43-char id for `arweave`), so an IPFS resolution survives a gateway
  hop and `ARNS_RESOLVER_PRIORITY_ORDER` no longer has to keep `on-demand` ahead
  of `gateway` for IPFS-targeted names. An upstream gateway that predates this
  still omits the header, which the reader defaults to `arweave` — so upgrade the
  upstream first for full IPFS coverage across a hop.

### Root and apex names

"Root" means three different things; only two route to IPFS:

- **A name's root (`@`) record** -- e.g. `my-name.gateway.tld` with no
  undername. The `@` record is just the `'@'` undername and goes through the
  same resolution + routing, so an IPFS `@` record serves IPFS. ✅
- **Gateway apex via `APEX_ARNS_NAME`** -- when the bare apex host has
  `APEX_ARNS_NAME` set, the middleware resolves that name through the normal
  path, so if its record targets IPFS the apex serves IPFS. ✅
- **Gateway apex via `APEX_TX_ID`** -- a fixed id served directly to the Arweave
  data handler, bypassing resolution and protocol routing. It is Arweave-only;
  a CID there will not serve. To serve IPFS at the apex, use `APEX_ARNS_NAME`
  pointing at an ANT whose `@` record targets IPFS. ❌

## Read-only mode: trust posture, trustless retrieval, and pinning

This integration is a **read-only IPFS mode**: the gateway serves IPFS content
that lives on the public IPFS network (via the Kubo sidecar). It does **not**
store IPFS content on Arweave — permapinning to Arweave (CAR ingest, content-
addressed indexing, chain-anchored proofs) is a separate, larger phase. In this
mode the gateway is a caching proxy with an optional client-verifiable path; the
durability of named content depends on it being pinned somewhere, not on Arweave
permanence.

### Two trust postures (and an honest header)

- **Trusted proxy (UnixFS path).** A plain `/ipfs/{CID}` or a name→CID request is
  reassembled by Kubo and served (and, if signing is on, HTTPSIG-signed). The
  signature attests *"a registered gateway served these bytes"* — it is **not** a
  content proof. The response carries `X-Ar-Io-Trustless: false`.
- **Trustless (verifiable) retrieval.** `GET /ipfs/{CID}?format=raw` returns a
  single verifiable block (`application/vnd.ipld.raw`); `?format=car` returns a
  verifiable DAG archive (`application/vnd.ipld.car`). Equivalent IPLD `Accept`
  types work too. These are forwarded to Kubo and relayed with
  `Content-Disposition: attachment`, `ETag` = the CID, and
  `X-Ar-Io-Trustless: true`. The **client** hashes the bytes and checks them
  against the CID — the gateway is not a trust root. This is the
  [IPFS Trustless Gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/)
  shape. Format responses bypass the UnixFS cache; a mid-stream size guard bounds
  large CARs, and the rate-limit reserve for unknown-size responses is
  `IPFS_RATE_LIMIT_UNKNOWN_SIZE_BYTES`.

Clients that need to *verify* content should request `?format=raw|car` and check
the CID; the UnixFS path is a convenience for browsers and is explicitly
gateway-trusted.

### Named-content pinning (availability)

Because read-only content lives on the public network and Kubo runs with GC, an
unpinned CID can disappear and an ArNS name pointing at it will `404`. With
`IPFS_PIN_ARNS_CONTENT=true` the gateway pins (via the Kubo RPC API) the CIDs that
ArNS names resolve to, so the *named* content it is responsible for stays
retrievable. Pinning is best-effort and fire-and-forget (never blocks a
response), bounded to `IPFS_PIN_MAX` distinct CIDs (oldest unpinned FIFO), and
scoped to ArNS-resolved content — not arbitrary `/ipfs/{CID}` traffic.

This is also the substrate an incentive layer would build on: rewarding gateways
for serving named IPFS data gives the fleet a reason to pin it, turning the AR.IO
gateway network into a durability layer for named IPFS content without Arweave
storage.

## Parity with the Arweave Data Path

The IPFS path is held to the same operational bar as the Arweave data path;
cross-cutting behaviors are shared or matched:

| Concern | Arweave path | IPFS path |
|---------|--------------|-----------|
| **Moderation** | `PUT /ar-io/admin/block-data` (id + hash) → `451` | Same admin API/store; `isIdBlocked(CID)` pre-serve, plus `isHashBlocked` once a CID's served-byte SHA-256 is known; CID-blocking is the deterministic pre-serve primitive |
| **Name blocking** | blocked ArNS name → `451` before serving | same middleware gate runs before IPFS dispatch |
| **Caching** | read-through content cache | bounded LRU IPFS cache; hash-blocked bytes are never persisted |
| **Negative cache** | absent ids short-circuit repeat lookups | absent/unpinned CIDs short-circuit (shared `NegativeDataCache`, with `evict`/`recordSuccess` on availability) |
| **HEAD / Range** | HEAD; `206`/`416`/`Accept-Ranges` | HEAD (no body); single-range `206` + `Content-Range` + `Accept-Ranges`; `416` on unsatisfiable |
| **Origin isolation** | `/{txid}` → per-id sandbox subdomain | `/ipfs/{CID}` → per-CID sandbox subdomain |
| **Rate limiting** | token bucket + IP/CIDR allowlist | separate IPFS token pools, same allowlist; Kubo concurrency cap bounds amplification |
| **HTTPSIG** | signed trust/envelope headers + `Content-Digest` | signed `X-ArNS-*` / `X-Ipfs-Path` / `X-Ar-Io-Source` / `ETag`; `Content-Range` bound on `206`; `Content-Digest` when the hash is known |
| **Protocol resolution** | — | `protocol` propagates across resolvers including a trusted-gateway hop (`X-ArNS-Protocol`) |
| **Observability** | Prometheus, OTEL, structured logs | dedicated IPFS metrics + OTEL spans + structured logs |
| **Error semantics** | `404`/`5xx` with cache-control | `404` (cache-controlled) / `451` / `413` / `416` / `502` / `504` |

**Inherent differences** (by design, not gaps): IPFS content is
content-addressed — the CID is its integrity proof and the gateway delegates
block verification to Kubo — and pinning-dependent (it can disappear if
unpinned), whereas Arweave data is permanent and Merkle-verified against its
signed `data_root`. The first, uncached fetch of never-seen content also cannot
be hash-blocked pre-serve (the SHA-256 is only known after streaming); use
CID-level blocking for deterministic pre-serve moderation of IPFS content.

## Differences from Arweave Data Serving

| Aspect | Arweave | IPFS |
|--------|---------|------|
| **Addressing** | Transaction ID (43-char base64url) | CID (variable length, base32 or base58) |
| **Permanence** | Guaranteed by protocol (incentivized storage) | Requires pinning; content disappears if unpinned |
| **Path resolution** | Manifest JSON parsed by the gateway | UnixFS directories resolved by Kubo |
| **Verification** | Merkle proofs verified by the gateway | Block hashes verified internally by Kubo |
| **Caching** | Archival (operators retain data long-term, often without eviction) | LRU with bounded size (eviction when full) |
| **Cache-Control** | Varies by verification status and data source trust | Direct CID: `immutable`, 1-year max-age (content-addressed). Via ArNS: the ArNS TTL (mutable name->CID binding) |
| **Rate limiting** | Shared Arweave token bucket | Separate IPFS token bucket |
| **Data source** | Multi-source fallback chain (cache, S3, peers, gateways, Arweave nodes) | Single source: local Kubo node |
| **Upstream network** | Arweave protocol (block weave, mining incentives) | IPFS/libp2p (DHT, Bitswap) |
| **Moderation** | Transaction-level blocklist | CID-level blocklist (with CIDv0/v1 normalization) |

## Observability

### Prometheus Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `ipfs_requests_total` | Counter | `status`, `method` | Total IPFS requests by HTTP status and method |
| `ipfs_cache_hit_total` | Counter | -- | Cache hits |
| `ipfs_cache_miss_total` | Counter | -- | Cache misses |
| `ipfs_content_size_bytes` | Histogram | -- | Distribution of served content sizes |
| `ipfs_request_duration_seconds` | Histogram | `source` (`cache`, `kubo`) | Request latency by data source |
| `ipfs_blocked_total` | Counter | -- | Requests blocked by the CID blocklist |

### Structured Logging

Each IPFS component creates a Winston child logger with a component-specific
label (e.g., `ipfs-service`, `kubo-data-source`, `ipfs-cache`). Log output
follows the gateway's standard JSONL format and is written to the same log
destination as all other gateway logs. Key log events:

- `ipfs-service`: Request start, cache hit/miss, Kubo fetch start/complete,
  errors.
- `kubo-data-source`: HTTP request details, timeout events, stream stalls.
- `ipfs-cache`: Eviction events, write errors, cleanup scan results.
- `ipfs-blocklist`: File reload events, blocked CID matches.

### OpenTelemetry Tracing

IPFS requests generate OpenTelemetry spans that are written to
`logs/otel-spans.jsonl` alongside Arweave request spans. The span hierarchy:

```
ipfs.request (root span)
  +-- ipfs.blocklist.check
  +-- ipfs.ratelimit.check
  +-- ipfs.cache.lookup
  +-- ipfs.kubo.fetch        (only on cache miss)
  +-- ipfs.cache.write       (only on cache miss)
```

Spans include attributes for the CID, path, cache hit/miss status, response
size, and Kubo fetch duration.
