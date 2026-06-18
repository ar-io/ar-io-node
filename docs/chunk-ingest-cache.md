# Optimistic Chunk Ingest Cache

## Overview

Normally `POST /chunk` broadcasts a chunk to the Arweave network and discards the
bytes locally — so if that data is later read or unbundled, the gateway re-fetches
it over the network. With the optimistic chunk ingest cache enabled, the gateway
also **validates and write-through caches** each posted chunk, so data posted
*through* the gateway (e.g. by a bundler seeding its chunks) is immediately
available locally.

Disabled by default (`CHUNK_INGEST_CACHE_ENABLED=false`).

## Scope

This feature caches chunk **bytes** only. Two related optimistic mechanisms are
separate:

- **Optimistic data-item indexing** — makes data items queryable by id before
  their bundle mines (`POST /ar-io/admin/queue-data-item`, already available).
- **Optimistic L1 transaction indexing** — instant resolvability of a tx/bundle
  *before* it mines — is **not yet implemented**.

So today the behavior is: chunks cache when posted; when their transaction mines
and is indexed they confirm and are served (and the unbundler reuses the cached
bytes instead of re-fetching). Instant pre-mine resolvability is future work.

## Enabling

| Variable | Default | Purpose |
|---|---|---|
| `CHUNK_INGEST_CACHE_ENABLED` | `false` | Master switch. |
| `CHUNK_INGEST_CACHE_ALLOWLIST` | `""` (open) | IPs/CIDRs whose posted chunks are cached. Empty = open ingest; set = only these posters earn caching (gates caching, not posting). |
| `CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS` | `21600` (6h) | GC leash for open-ingest chunks whose `data_root` never confirms. |
| `CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS` | `86400` (24h) | Longer GC leash for allowlisted posters. |
| `CHUNK_INGEST_MAX_PENDING_BYTES` | `26843545600` (25 GiB) | Runaway-disk backstop; oldest pending evicted first above this. `0` disables. |
| `CHUNK_INGEST_GC_INTERVAL_MS` | `300000` (5m) | GC sweep interval. |
| `CHUNK_INGEST_GC_BATCH_SIZE` | `1000` | Max evictions per sweep. |

For a bundler integration, set `CHUNK_INGEST_CACHE_ALLOWLIST` to the bundler's
egress IP/CIDR and point the bundler's chunk-post endpoint at this gateway.

## How it works

1. `POST /chunk` → `validateChunk`: `sha256(chunk)` must match the `data_path`
   leaf, and the merkle proof must validate against the asserted `data_root`. An
   invalid chunk is rejected and not cached.
2. Valid → the bytes are written to the chunk store and a **pending** row is
   recorded in `chunks.db` → `chunk_placements` (`confirmed_at` NULL). This is
   fire-and-forget and never blocks the broadcast response.
3. When a transaction with that `data_root` is indexed, the `TX_INDEXED` event
   sets `confirmed_at` and records `chunk_ingest_confirmation_latency_seconds`.
4. A GC worker evicts placements whose `data_root` never confirms on-chain
   (tiered TTL by origin) plus a disk-pressure backstop.

## Integrity model

The gateway must never serve or permanently keep data that is not on chain. This
is upheld by:

- **Validate-on-ingest** — only chunks that merkle-validate against their asserted
  `data_root` are cached, so a *real* transaction cannot be poisoned (only the
  genuine bytes validate).
- **Unaddressable until confirmed** — serving resolves an id/offset to a
  `data_root` through the index, which contains only mined transactions; a pending
  (unconfirmed) chunk therefore cannot be served.
- **Confirmation-driven cleanup** — a placement is kept *iff* its `data_root` is
  indexed; never-confirmed placements are evicted. The TTL is just the patience
  window.
- **`verified` only after real verification** — optimistic data is never labeled
  `verified` until the background verification worker checks it post-confirmation.
- **Open ingest is safe** because a junk chunk (fake `data_root`) is unaddressable
  and GC-reclaimed; the allowlist further restricts which posters earn caching.

> An active "do not serve until `confirmed_at`" read guard is intentionally
> deferred to the future optimistic-tx-index feature, where optimistic tx indexing
> would make a pending tx's `data_root` resolvable (and thus create the exposure
> this guard protects against).

## Abuse resistance (disk fill)

Open ingest (empty allowlist) lets any client POST chunks, so disk fill is bounded
two ways:

- **Synchronous disk cap** — `CHUNK_INGEST_MAX_PENDING_BYTES` (default 25 GiB) is
  enforced *at ingest*: once the pending (unconfirmed) total would exceed it,
  further caching is rejected immediately
  (`chunk_ingest_cache_total{result="skipped_disk_full"}`), not minutes later by
  the sweep — so a burst cannot overrun the disk.
- **Confirmation-driven GC** — anything that never confirms is evicted after the
  TTL.

For production, prefer **allowlist-only** (`CHUNK_INGEST_CACHE_ALLOWLIST` = your
bundler) so only a trusted poster earns caching. Note the cap bounds *disk*, not
request *rate*: `POST /chunk` still does its normal broadcast/validation work
regardless of caching, so put a rate limiter / auth in front of it before exposing
open ingest on a public endpoint.

## Tuning

Set `CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS` comfortably above your worst-case
POST→index latency. Measure the real distribution on your deployment from the
`chunk_ingest_confirmation_latency_seconds` histogram and tune down toward
`p99 + margin`. Too short only loses cache benefit (re-fetch on read); too long is
bounded by the disk-cap and unserveable.

## Metrics

All at `/ar-io/__gateway_metrics`:

| Metric | Meaning |
|---|---|
| `chunk_ingest_cache_total{result}` | Outcome per POST: `cached`, `cached_allowlisted`, `invalid`, `skipped_not_allowlisted`, `skipped_disk_full`. |
| `chunk_ingest_confirmed_total` | Pending placements confirmed by tx-indexed events. |
| `chunk_ingest_confirmation_latency_seconds` | POST→confirm latency histogram (use to tune the TTLs). |
| `chunk_ingest_evicted_total{reason}` | GC evictions: `ttl`, `disk_pressure`. |
| `chunk_ingest_pending_bytes` | Estimated bytes held by pending (unconfirmed) placements. |
