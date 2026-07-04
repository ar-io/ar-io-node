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
- **Optimistic L1 transaction indexing** — id-resolvability of a signed tx/bundle
  *before* it mines — has since shipped (see
  [`madr/004-optimistic-l1-tx-indexing.md`](madr/004-optimistic-l1-tx-indexing.md)),
  with a serving guard that withholds the `verified` stamp until the tx mines.

So today the behavior is: chunks cache when posted; when their transaction mines
and is indexed they confirm and are served (and the unbundler reuses the cached
bytes instead of re-fetching). Pre-mine byte-serving of `/raw/<id>` from this
cache stays deferred (MADR 004 Scope 2), so a pending placement is cached but not
served until its tx mines.

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
   fire-and-forget and never blocks the broadcast response. If the `data_root` is
   *already* confirmed (marker present, or a confirmed sibling exists), the new
   row inherits its `confirmed_at` on the spot (see "sticky confirmation" below).
3. When a transaction with that `data_root` is indexed, the `TX_INDEXED` event
   sets `confirmed_at` and records `chunk_ingest_confirmation_latency_seconds`.
   This is a **one-shot** update: it only touches placements that already exist
   at that instant. **Sticky confirmation** carries the result forward. The same
   event records the `data_root` in `confirmed_data_roots` (gated on there being
   at least one ingested chunk, so the table stays bounded by ingested bundles),
   and that marker makes confirmation persistent:
   - `saveChunkPlacement` inherits `confirmed_at` from the marker, so every chunk
     ingested *after* the confirm event self-confirms at ingest; and
   - the GC TTL sweep skips any `data_root` in `confirmed_data_roots`, so a
     confirmed bundle is never partially evicted regardless of per-row state.

   Without this, a large multi-GB bundle (thousands of chunks streamed in over a
   window longer than one confirm event) leaves most chunks unconfirmed; they
   then TTL-evict and leave a gappy, unservable set (e.g. `relative_offset` 0
   missing → range streaming from offset 0 misses and the whole bundle fails to
   serve/unbundle until it re-propagates from peers).
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

> Optimistic L1 tx indexing (MADR 004) can make a pending tx's `data_root`
> resolvable, so the verification worker withholds `verified` while the tx is
> unmined and pre-mine byte-serving from this cache stays deferred — a pending
> placement is still never served.

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
| `chunk_ingest_pending_bytes` | Estimated bytes held by pending (unconfirmed) placements. Refreshed on the GC sweep, so it can lag writes by up to one sweep interval — use `chunk_ingest_cache_total` for live confirmation. |
