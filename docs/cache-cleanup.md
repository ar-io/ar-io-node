# Contiguous Data Cache Cleanup

The contiguous data cache (`data/contiguous/data/<hh>/<hh>/<hash>`) is
content-addressed and grows without bound unless something reclaims it. Two
independent reclaimers can do that. They share the same disk-usage watermark
environment variables but interpret them differently, so pick one for a given
deployment.

Both watch the cache filesystem with `statfs` (an O(1) syscall), which is the
**authoritative** signal for "how full is the disk." Everything else (the index,
TTLs, byte counters) only decides *which* blobs to remove — never *whether* the
disk is actually full.

## The two reclaimers

### 1. Filesystem-walk worker (`FsCleanupWorker`)

- **Enabled when** `CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD` is set (a base TTL
  in seconds).
- **How it reclaims:** periodically walks the sharded blob tree and deletes
  files older than an effective TTL.
- **Watermarks tune the TTL (dynamic TTL):**
  - Below `LOW_WATERMARK_PERCENT` → cleanup is **skipped entirely** and the cache
    grows to fill the disk — **unless** free space is below `MIN_FREE_BYTES`,
    which independently forces aggressive cleanup regardless of usage percent
    (see below).
  - At/above `HIGH_WATERMARK_PERCENT` (or below `MIN_FREE_BYTES`) → cleanup runs
    **aggressively**; the effective TTL is progressively tightened from the base
    threshold (at the high watermark) toward `AGGRESSIVE_MIN_AGE_SECONDS` (at a
    full disk, or immediately when the free-space floor is breached). Hysteresis:
    once aggressive, it keeps draining until usage recovers below the low
    watermark **and** free space is back above `MIN_FREE_BYTES`.
  - `AGGRESSIVE_MIN_AGE_SECONDS` is an absolute floor — data younger than this is
    never deleted, even at 100% full.
- **Cost:** a full walk of `data/contiguous` is `O(files)` random-access I/O. On
  a large **spinning-disk** cache (tens of TB, tens of millions of blobs) the
  walk is seek-bound and cannot keep up. Use the index evictor there instead.

### 2. Index evictor (`ContiguousDataCacheEvictor`) — recommended for large caches

- **Enabled when** `ENABLE_CONTIGUOUS_DATA_CACHE_INDEX=true`.
- **How it reclaims:** maintains an SSD-resident SQLite index
  (`contiguous_data_cache`) of every cached blob — populated by a write hook on
  cache writes, so no filesystem walk is needed to decide *what* to evict. When
  the disk crosses the high watermark it queries the index for the best eviction
  candidates and removes them (delete the index row, then unlink the blob) until
  the disk recovers.
- **Watermarks are a pressure trigger + drain target (no TTL):**
  - At/above `HIGH_WATERMARK_PERCENT` (or below `MIN_FREE_BYTES`) → eviction is
    **triggered**.
  - Eviction runs until usage falls **below** `LOW_WATERMARK_PERCENT` **and**
    free space is back above `MIN_FREE_BYTES` (the drain-down-to target), or the
    index is drained.
  - `AGGRESSIVE_MIN_AGE_SECONDS` is **ignored** — the evictor has no age floor.
- **Eviction order:** `ORDER BY tier ASC, last_access ASC` — general-tier blobs
  before preferred-tier, oldest-accessed first within a tier (LRU).

## The index model (evictor path)

**LRU via `last_access`.** Each blob's index row carries `cached_at` (write time,
informational) and `last_access` (drives eviction order). When
`CONTIGUOUS_DATA_CACHE_INDEX_UPDATE_ON_READ=true` (default), a cache **hit**
refreshes `last_access`, so hot blobs sink to the bottom of the eviction queue.
With it `false`, `last_access` never moves after write and eviction degrades to
FIFO (oldest-written first).

> Note: `last_access` reflects only reads that actually reach the gateway. If a
> caching/reverse proxy sits in front of it (a common deployment), the proxy
> absorbs a share of repeat reads, so those hits never refresh `last_access`.
> LRU here is a best-effort demand signal, not an exact one.

**Tiering (preferred ArNS).** Blobs served for a preferred ArNS name are promoted
to tier 1 and evicted only after all tier-0 (general) blobs are gone. A blob
enters tier 1 either at cache-write time (its request matched
`PREFERRED_ARNS_NAMES` / `PREFERRED_ARNS_BASE_NAMES`) or on a later read that
matches (promotion; the tier is raised with `MAX()` and never demoted).

**Backfill / reconciler (`ContiguousDataCacheReconciler`).** Enabled with
`ENABLE_CONTIGUOUS_DATA_CACHE_INDEX_BACKFILL=true`, it does a one-time walk of the
existing on-disk cache to seed index rows for blobs written before the index
existed (all seeded as tier 0). It is **resumable** — a per-shard checkpoint file
(`data/contiguous/.cache-index-backfill-checkpoint`) lets a restart skip
already-completed shards. Turn it **off** once it has completed a full pass; the
write hook keeps the index current thereafter.

**Drift is harmless.** `statfs` is authoritative for pressure, so index/disk drift
never over-deletes: a stale index row just unlinks a missing file (ENOENT is
ignored), and a blob missing from the index simply isn't an eviction candidate —
the filesystem-walk worker can still run occasionally as a reconciler if desired.

**Byte metrics are logical, not physical.** `cache_index_evicted_bytes_total` and
the size gauges are uncompressed logical sizes. On a compressing filesystem
(e.g. btrfs zstd) the physical space freed is smaller, so trust
`node_filesystem_avail_bytes` / `df` — not the byte counters — for actual disk
reclaimed. This is fine: the evictor's stop condition is `statfs`, not the byte
sum.

## Choosing and configuring

| Situation | Use |
|---|---|
| Large / spinning-disk cache (walk can't keep up) | Index evictor (`ENABLE_CONTIGUOUS_DATA_CACHE_INDEX=true`) |
| Small / SSD cache, simple TTL semantics | Filesystem-walk worker (`CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD` set) |

Recommended large-cache setup:

- `ENABLE_CONTIGUOUS_DATA_CACHE_INDEX=true`
- `ENABLE_CONTIGUOUS_DATA_CACHE_INDEX_BACKFILL=true` for the first run, then unset
  once the backfill completes.
- `CONTIGUOUS_DATA_CACHE_HIGH_WATERMARK_PERCENT` / `_LOW_WATERMARK_PERCENT` set to
  a sensible band (e.g. evict at the high mark, drain to the low mark — keep the
  band a few points wide so eviction isn't constantly re-triggering).
- `CONTIGUOUS_DATA_CACHE_MIN_FREE_BYTES` as an absolute ENOSPC backstop for a
  volume shared with SQLite DBs/WAL/logs.
- Leave `CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD` unset so the filesystem-walk
  worker doesn't also run (or set it if you want it as an occasional reconciler).

See [Environment Variables](envs.md) for the full list of related settings.
