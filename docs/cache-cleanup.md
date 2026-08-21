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

## Scope: the chunk data cache is a separate volume — with its own evictor

Everything above describes the **contiguous** data cache. The **chunk** data
cache (`data/chunks`) is a separate volume with a separate lifecycle, tuned by
the `CHUNK_DATA_CACHE_*` settings rather than the `CONTIGUOUS_DATA_CACHE_*` ones
above. As of ADR 005 it has the **same two reclaimers**: the filesystem-walk
worker (`FsCleanupWorker`, enabled by default via
`ENABLE_CHUNK_DATA_CACHE_CLEANUP`) and an index evictor
(`ChunkDataCacheEvictor`, opt-in via `ENABLE_CHUNK_DATA_CACHE_INDEX`).

### Orphaned absolute-offset symlinks

Index eviction reclaims a whole data-root directory at a time, which orphans
every `by-absolute-offset` symlink pointing into it at once.
`SymlinkCleanupWorker` reaps those on `CHUNK_SYMLINK_CLEANUP_INTERVAL`
(default **24 h**). Measured on a production gateway ~10 h after a 778 GB
data-root-scoped reclaim, **15.6%** of sampled absolute-offset symlinks were
already dangling.

This is not a correctness problem — a dangling link reads as ENOENT, which
`getByAbsoluteOffset` treats as a cache miss, and a later chunk claiming the
same offset replaces the link atomically. But orphans hold inodes and cost a
failed syscall plus a refetch until they are reaped, so shorten
`CHUNK_SYMLINK_CLEANUP_INTERVAL` when enabling the evictor on a large chunk
cache.

The walk cost described above applies to the chunk cache with interest: it holds
far more objects than a contiguous cache of the same size (millions of ~256 KiB
chunks vs whole blobs). On a production gateway the chunk cleanup walk was
measured spending 93.9 s of every 94.9 s batch cycle traversing rather than
deleting; on a second gateway it logged "No more files to delete, restarting
from the base path" while **86.7% of cached bytes were already older than its
own age floor**. Discovery, not eligibility, is the constraint — which is why
the "use the index evictor on large caches" advice above now has a chunk-side
equivalent.

### Enabling the chunk index evictor

`ENABLE_CHUNK_DATA_CACHE_INDEX=true` turns on all three parts at once: the write
hook on `FsChunkDataStore.set()`, the read hook, and the evictor. The index is
the `chunk_data_cache` table in **`chunks.db`** (not `data.db`), one row per
data root.

| Variable                                             | Default      | Meaning                                                                                                              |
| ---------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ENABLE_CHUNK_DATA_CACHE_INDEX`                      | `false`      | Master switch: write hook, read hook, and evictor.                                                                   |
| `CHUNK_DATA_CACHE_INDEX_EVICTION_INTERVAL_MS`        | `60000`      | How often the evictor checks disk pressure.                                                                          |
| `CHUNK_DATA_CACHE_INDEX_EVICTION_BATCH_SIZE`         | `1000`       | Max index rows considered per batch within a sweep.                                                                  |
| `CHUNK_DATA_CACHE_INDEX_EVICTION_TARGET_BYTES`       | `1073741824` | Bytes a batch aims to free (1 GiB). This is what makes eviction size-aware.                                          |
| `CHUNK_DATA_CACHE_INDEX_UPDATE_ON_READ`              | `true`       | Refresh `last_access` on cache hits (LRU). `false` degrades to FIFO by write time — reasonable behind an edge cache. |
| `ENABLE_CHUNK_DATA_CACHE_INDEX_BACKFILL`             | `false`      | One-time walk to seed rows for a pre-existing on-disk cache. **Requires `ENABLE_CHUNK_DATA_CACHE_INDEX=true`.**      |
| `CHUNK_DATA_CACHE_INDEX_BACKFILL_BATCH_SIZE`         | `2000`       | Rows buffered per backfill insert transaction.                                                                       |
| `ENABLE_CHUNK_DATA_CACHE_INDEX_HYBRID_TAIL`          | `false`      | **Reserved — currently inert.** Nothing reads it; enabling it does nothing.                                          |
| `CHUNK_DATA_CACHE_INDEX_HYBRID_TAIL_CHUNK_THRESHOLD` | `100`        | **Reserved — currently inert.**                                                                                      |

Pressure thresholds are **not** separate: the evictor reuses
`CHUNK_DATA_CACHE_HIGH_WATERMARK_PERCENT`, `CHUNK_DATA_CACHE_LOW_WATERMARK_PERCENT`
and `CHUNK_DATA_CACHE_MIN_FREE_BYTES` — trigger at the high mark (or below the
free-space floor), drain to the low mark, `statfs` authoritative throughout,
exactly as on the contiguous side.

There is one knob that does **not** exist, deliberately: the eviction age floor.
See below.

### Eviction is data-root granular and size-aware, not coldest-first

The unit is the whole `by-dataroot/<hh>/<hh>/<dataRoot>/` directory, removed via
`FsChunkDataStore.delDataRoot()` — not an individual chunk file. Rows carry
`size` and `chunk_count` for the entire data root.

Selection is `ORDER BY tier ASC, last_access ASC` like the contiguous evictor,
but a batch then **accumulates candidates until it reaches
`CHUNK_DATA_CACHE_INDEX_EVICTION_TARGET_BYTES`** instead of evicting a fixed
number of coldest rows. That is forced by the size distribution: measured in
production, the median data root holds ~2 chunks (~0.5 MiB) while the top 1% of
data roots hold ~50% of all chunks (p90 ~101 chunks, max ~25,000). A
coldest-first batch of N rows would repeatedly reclaim half-megabyte
directories — paying N index reads and N unlinks to free almost nothing — while
the disk kept filling.

The mirror image of that skew is the known limitation: a large data root is an
all-or-nothing eviction unit, so one hot chunk can pin a multi-GiB entry. The
"hybrid tail" knobs above are the placeholder for fixing that and are inert
today.

### The age floor — a correctness control, not a tuning knob

**Read this before enabling the evictor.** The contiguous evictor deliberately
**ignores** `AGGRESSIVE_MIN_AGE_SECONDS` (stated earlier in this document): it
has no age floor, and that is safe for content-addressed blobs. The chunk
evictor **must** honour one, and does.

When the optimistic chunk ingest cache is on, this gateway is the only place a
freshly POSTed chunk lives until its data root confirms on chain. Evicting it
early breaks upload propagation — and it breaks it **silently**: the poster
already received its 200, the bytes are simply gone when the network comes
asking, and the failure resurfaces much later as an unrelated "data
unavailable". There is no error to alert on.

The floor is therefore **derived in code, not read from the environment**, so it
cannot drift out of step with the ingest configuration it has to respect:

```
CHUNK_DATA_CACHE_INDEX_MIN_AGE_SECONDS =
  CHUNK_INGEST_CACHE_ENABLED
    ? max(CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS,
          CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS)
    : CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS
```

At stock defaults with ingest caching **on**, that is
`max(3600, 86400)` = **86,400 s (24 h)** — the allowlisted-poster confirmation
window, because the floor must cover the worst case, and that timeout is the
longer of the two ingest leashes (`CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS`
defaults to 21,600 s / 6 h). With ingest caching **off** (the default) there is
no locally-originated chunk to protect and the floor collapses to
`CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` (default 3,600 s / 1 h), the same
floor the walk worker honours.

Consequences for operators:

- **Do not treat `CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` as a pressure
  knob on a gateway that ingests chunks.** Lowering it to make the evictor more
  aggressive lowers a correctness floor. Size the volume instead.
- The floor is enforced twice — in the index query (`last_write <= now - floor`)
  and again per candidate inside the evictor — because a filter that quietly
  stopped applying would fail invisibly.
- `chunk_cache_index_skipped_floor_total` counts candidates held back by the
  floor. A rising value under disk pressure means the floor, not the evictor, is
  what is limiting reclamation; that is the signal to add capacity, not to lower
  the floor.
- The floor keys off `last_write` — MAX(write time) across the data root's
  chunks, advanced on every chunk write — **not** first-cached time. A read
  never advances it. This is what stops a long-lived data root that just
  received a fresh chunk from being evicted whole.
- The same constraint has always applied to the walk worker:
  `CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` must stay above the ingest
  confirmation lag, or the walk frees bytes out from under a placement the
  ingest GC still considers in flight (`row present, bytes gone` → later cache
  misses). Measure that lag from the `chunk_placements` table, not from
  `chunk_ingest_confirmation_latency` — the counter is process-lifetime scoped
  and drops the slow tail.

### Prerequisite: the `set()` ENOENT retry (PR #867)

Enabling the evictor means data-root **directories** get removed. That races
`FsChunkDataStore.set()`, which does `mkdir` then `writeFile`: if the directory
is evicted between those two calls, the write fails with ENOENT and the chunk is
**silently dropped** — the caller believes it was cached.

The retry that closes that window (recreate the directory and write once more)
ships in **PR #867**. **An image that predates it must not run the evictor.** If
you are unsure, check for the ENOENT retry in `src/store/fs-chunk-data-store.ts`
before setting `ENABLE_CHUNK_DATA_CACHE_INDEX=true`. Note the corollary for
manual emergency sweeps: delete **files only** (`find … -type f … -delete`),
never `rmdir`, on an image without the retry.

### Rollout order

The same staged rollout proven on the contiguous side:

1. **Table + write hook.** `ENABLE_CHUNK_DATA_CACHE_INDEX=true` on a node whose
   image includes the ENOENT retry. Let the index accumulate and confirm it
   tracks the filesystem (`chunk_cache_index_entries`, `chunk_cache_index_bytes`).
2. **Backfill.** `ENABLE_CHUNK_DATA_CACHE_INDEX_BACKFILL=true` for one pass to
   adopt the pre-existing on-disk cache, then turn it back off. It is
   insert-if-absent, so it can never clobber a live write-hook row, and it is
   resumable via a per-shard checkpoint
   (`data/tmp/chunk-cache-index-backfill-checkpoint`). It runs in the
   background without blocking startup; a full pass over a ~129k-directory /
   ~917k-file production tree took ~35 s. **Operational rule: the backfill flag
   does nothing on its own** — `system.ts` gates the reconciler on _both_
   `ENABLE_CHUNK_DATA_CACHE_INDEX` and
   `ENABLE_CHUNK_DATA_CACHE_INDEX_BACKFILL`, so a backfill can never seed rows
   while the write hook is off (which would leave the index frozen and stale).
3. **Evictor.** Enable on one node under real pressure and watch
   `chunk_cache_index_evicted_bytes_total` and
   `chunk_cache_index_skipped_floor_total` against `df`.
4. **Compare** against an un-migrated node before rolling out fleet-wide.

### Keep the walk worker available as a reconciler

Leave `ENABLE_CHUNK_DATA_CACHE_CLEANUP` on (or re-enable it periodically). Index
drift is benign in the safe direction — `statfs` is authoritative for pressure, a
stale row unlinks a missing directory (ENOENT ignored), and an unindexed file is
simply not a candidate — but an _unindexed_ file is also never reclaimed by the
evictor, and index/filesystem drift has bitten this codebase before (ADR 005
records a contiguous index that was empty on one gateway while its evictor freed
0 bytes per sweep). At chunk cardinality the reconciler is not optional. The
evictor distinguishes the two cases in its logs: "index drained but still over
pressure" (drift — run the walk worker) versus "all remaining entries are inside
the age floor" (working as designed — add capacity).

> [!WARNING]
> **The walk worker does not honour the derived age floor, and it deletes.**
> `FsCleanupWorker` is a destructive TTL reclaimer, not a read-only drift
> scanner. Under pressure its floor is `CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS`
> alone, which is **independent of** the ingest confirmation timeouts the index
> evictor's floor is derived from. If it is set below
> `max(CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS, CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS)`
> while `CHUNK_INGEST_CACHE_ENABLED=true`, the walk worker can delete an
> unconfirmed chunk before its confirmation window closes — the exact failure
> the evictor's floor exists to prevent, reached by the other reclaimer.
>
> This is **not** specific to the index evictor: it applies to any gateway
> running the walk worker with ingest caching on, including deployments that
> never enable the index. When running both, either raise
> `CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` to meet the derived floor, or
> run the walk worker only as an occasional manual sweep with an age floor at
> least as large.

See [ADR 005](madr/005-chunk-data-cache-indexed-eviction.md) for the
measurements and the design rationale, and [Environment Variables](envs.md) for
the full list of related settings.
