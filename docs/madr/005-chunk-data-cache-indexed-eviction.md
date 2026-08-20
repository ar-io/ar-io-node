# Indexed Eviction for the Chunk Data Cache

- Status: proposed
- Deciders: [Ariel, Phil]
- Date: 2026-08-19
- Authors: [Phil]

## Context and Problem Statement

The chunk data cache
(`data/chunks/gateway/data/by-dataroot/<hh>/<hh>/<dataRoot>/<relativeOffset>`)
is reclaimed only by `FsCleanupWorker`, the filesystem-walk reclaimer. Its
sibling, the contiguous data cache, has both the walk worker **and** an indexed
evictor (`ContiguousDataCacheEvictor` + `ContiguousDataCacheReconciler`, backed
by the `contiguous_data_cache` SQLite table).
[docs/cache-cleanup.md](../cache-cleanup.md) already recommends the index
evictor for large caches and states the walk "cannot keep up" on them.

The chunk cache is the larger of the two by object count and has no evictor.

On 2026-08-18/19 this produced a production incident on `turbo-gw-fsn1-1`: the
chunk volume filled to 100%, ENOSPC errors appeared, and recovering it required
several rounds of config tuning — one of which
(`CHUNK_DATA_CACHE_MIN_FREE_BYTES` against an already-full volume) caused ~12%
5xx for several minutes.

This ADR proposes porting the indexed-evictor pattern to the chunk cache, with
two chunk-specific departures that are **not** optional.

## Decision Drivers

- Eviction throughput must exceed the chunk write rate without operator tuning.
- Chunks pending seed confirmation must never be evicted (correctness, not
  perf).
- The design must fit the chunk cache's very different object-size distribution.
- Prefer reusing a pattern already proven in this codebase over inventing one.

## Measurements

All figures from `turbo-gw-fsn1-1` (1 TiB XFS LV, NVMe), 2026-08-18/19. Sampling
was bounded (random prefix selection, capped `stat()` counts); no `du` or
full-tree walk was run.

### The walk is the bottleneck

At `AGGRESSIVE_MIN_AGE_SECONDS=7200`, batches of 6,800 files:

```
mean gap between batches   94.9 s
configured inter-batch pause 1.0 s   (5000ms base, scaled by pressure 0.80)
=> time spent walking       93.9 s of 94.9 s   (99%)
deletion throughput         ~60 GB/hr
measured gross write rate   ~85 GB/hr
```

Deletion lost to ingest by ~25 GB/hr, so the volume filled regardless of
watermark pressure. Every other lever was already exhausted: batch size was at
its 4x cap, the pause was effectively zero, and walk concurrency was at the safe
ceiling (4 workers x 8 = 32 = `floor(UV_THREADPOOL_SIZE/2)`).

Lowering the age floor to 1800 s shortened the batch cycle from 94.9 s to ~5.0 s
(~19x) purely by raising the density of eligible files encountered per unit of
traversal. That confirms the walk — not deletion, not I/O — is the constraint.
Device utilisation stayed at 3.4% (`r_await` 0.10 ms) throughout, so this was
never an I/O limit.

### Why the walk is so expensive: object shape

```
est. populated dataRoot dirs   ~37,581
est. chunk files              ~4,474,402
chunks per dataRoot            mean 125, p50 2, p75 14, p90 79, p99 2,815, max 11,218

top  1% of dataRoots hold 55.7% of all chunks
top  5%                   87.2%
top 10%                   94.4%
```

Half of all populated dataRoot directories hold **two chunks or fewer**, and a
separate census found **67% of dataRoot directories are entirely empty**
(nothing ever calls `rmdir`; see Risks). The walk therefore spends nearly all of
its time on directories that contain almost none of the bytes — a ~3x readdir
amplification on top of an already unnecessary traversal.

### Cardinality vs the proven pattern

```
contiguous_data_cache index (live)   180,383 rows
chunk cache, per-chunk indexing    ~4,474,402 rows   (~25x)
chunk cache, per-dataRoot indexing     ~37,581 rows   (~0.2x)
```

### Reuse profile (drives retention, and shows the cache is over-provisioned)

XFS is mounted `relatime`, so on a fresh file `atime == mtime` and the _first_
read moves `atime`; `atime - mtime` is therefore time-to-first-reuse. Restricted
to files younger than 24 h (n=764) to avoid relatime's 24 h refresh rule:

```
p50 0.4 min · p90 0.5 min · p95 1.7 min · p99 25.3 min · max 188 min
97.8% of reuse within 15 min · 99.3% within 30 min
64.5% of chunks are never read again at all
```

At the 75% low watermark the volume holds ~768 GiB ~= 9 hours of chunk history
against a measured reuse need of ~0.5 h. **The volume is not undersized** — it
is roughly 18x larger than the workload requires. The failure was reclaim
throughput, not capacity.

### Independent corroboration on `turbo-gw-fsn1-2`

The same failure was measured on the second gateway on 2026-08-19/20, after it
had been upgraded to `develop` with PR #847 in place. Different node, different
traffic mix (~42% of inbound requests are `/chunk/*`), same conclusion.

```
inter-batch gap          median 67.7 s  (min 39.5, max 429.5)
pause floor in effect    250 ms          => pause is 0.4% of the cycle
batch size in use        ~7,450          => already the 4x aggressive cap
candidates per scan step avg 252
achieved delete rate     8.2 GB/hr
device utilisation       1.84%           (NVMe, idle throughout)
```

Two operational notes from that node:

- **`chunk_placements` already indexes part of the cache.** The optimistic
  ingest path maintains 876,850 rows against ~4.29M chunk files on disk —
  **20.4% coverage**, per-chunk, in a separate `chunks.db` with its own WAL. It
  is not a candidate vehicle for eviction (it is per-chunk, which this ADR
  rejects as option 3, and its GC index serves the confirmation lifecycle) but
  it is prior art for the write hook, and its separate WAL is a useful precedent
  for keeping eviction bookkeeping off `data.db`.
- **PR #847 alone did not hold.** With watermarks active the volume still
  reached 99% twice in 24 hours and needed two manual `find -delete` sweeps.
  This is consistent with the ADR's framing of #847 as a stopgap: watermarks
  scale the batch, they cannot make discovery faster.

### Seeding safety envelope

```
chunk_ingest_confirmation_latency: n=1,406, ALL <= 120 s, mean 21.4 s
arweave_chunk_post_total tracks ~1:1 with chunk_ingest_cache_total
chunk_ingest_pending_bytes: 0
```

Propagation is **push-at-ingest**, not replay-from-cache: chunks are POSTed to
`PREFERRED_CHUNK_POST_NODE_URLS` on arrival (needing
`CHUNK_POST_MIN_SUCCESS_COUNT` acceptances). Eviction cannot un-send that. But a
chunk evicted before confirmation is still a correctness problem for the
placement index, which is why the age floor below is mandatory.

## Considered Options

1. **Keep tuning the walk** (thresholds, watermarks, walk concurrency).
   Rejected: every lever is already at its limit, and the one that works
   (lowering the age floor) works only by accident of eligible-file density.
2. **Grow the volume.** Rejected: measurements show 18x more capacity than the
   reuse profile needs. It would delay, not fix, the throughput problem.
3. **Port the indexed evictor, per-chunk granularity.** Viable but ~25x the
   proven row count, and `UPDATE_ON_READ` would fire on every chunk read
   (~99k/hr) — meaningful WAL churn on a `data.db` already at 2.9 GB.
4. **Port the indexed evictor, per-dataRoot granularity with a hybrid tail.**
   Proposed below.

## Decision Outcome

Port `ContiguousDataCacheEvictor` / `ContiguousDataCacheReconciler` to the chunk
cache, keyed on **dataRoot** rather than individual chunk, with two mandatory
departures from the contiguous implementation.

### Departure 1 (correctness): the evictor MUST honour an age floor

`docs/cache-cleanup.md` states that for the contiguous evictor
"`AGGRESSIVE_MIN_AGE_SECONDS` is **ignored** — the evictor has no age floor."

That is safe for contiguous data. It is **not** safe for chunks: the floor is
what guarantees a chunk is not evicted before its placement confirms. Measured
confirmation is <=120 s, so the floor is what keeps a 15x-60x safety margin.

The chunk evictor must therefore exclude candidates younger than the
confirmation window. Porting the contiguous semantics verbatim would introduce a
data-propagation bug. This is the single most important review point in this
document.

**The obvious floor value is not sufficient.** Taking
`CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` as the floor leaves a gap, because
it is configured shorter than the window it has to cover:

```
CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS         =  7,200s (2h)   <- candidate floor
CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS           =  7,200s (2h)
CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS = 14,400s (4h)   <- longer
```

An allowlisted chunk therefore becomes evictable **two hours before its
confirmation window expires**. Measured confirmation is <=120 s, so the
practical exposure is small, but the timeout is the contract and eviction should
not violate it merely because the common case is fast.

The floor should be _derived_, not duplicated, so it cannot drift out of step
with the ingest configuration:

```
effectiveFloor = max(CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS,
                     CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS)
```

applied when ingest caching is enabled. Retaining 4 h rather than 2 h is free on
a volume the measurements above show to be ~18x larger than the reuse profile
requires.

An alternative, arguably cleaner: give unconfirmed ingest chunks their own tier
(see Departure 3) and let the floor apply only to tier 0. Either works; the
floor is the simpler and more conservative starting point.

### Departure 2 (fit): index by dataRoot, with a hybrid tail

Index one row per dataRoot directory (~37,581 rows — _smaller_ than the proven
contiguous index) rather than per chunk (~4.5M).

Because of the skew, eviction must be **size-aware**, not simply coldest-first:
a naive "evict the LRU entry" would frequently select a 0.5 MiB dataRoot (p50 =
2 chunks) and reclaim nothing. The query should accumulate candidates until a
byte target is met, which the existing `size` column already supports.

The skew also creates the one genuine hazard: a dataRoot at p99 (675 MiB) or max
(2.69 GiB) is an all-or-nothing eviction unit. Under dataRoot-level LRU a
**single** hot chunk keeps the entire entry resident — and the top 1% of entries
hold 55.7% of all bytes, so exactly the entries that matter most are the ones at
risk of becoming effectively unevictable.

Mitigation (the "hybrid tail"): above a size threshold (suggest > 100 chunks,
~p90), either track `last_access` per chunk for that dataRoot, or permit partial
age-ordered eviction within it. Small dataRoots — the overwhelming majority by
count, and a rounding error by bytes — stay whole-unit.

### Departure 3 (optional): tier by ingest origin

The contiguous evictor tiers by preferred-ArNS. The natural chunk analogue is
ingest origin: chunks POSTed by an allowlisted bundler
(`CHUNK_INGEST_CACHE_ALLOWLIST`) and not yet confirmed are tier 1; everything
cached by the read-through serving path is tier 0. Given that 64.5% of
serving-path chunks are never read again, tier 0 is where eviction should
concentrate anyway.

## Proposed Schema

Mirrors `contiguous_data_cache` so the evictor logic ports with minimal change:

```sql
CREATE TABLE chunk_data_cache (
  data_root   TEXT    NOT NULL PRIMARY KEY,  -- b64url, matches on-disk dir name
  size        INTEGER NOT NULL,              -- summed bytes of chunks under it
  chunk_count INTEGER NOT NULL,              -- drives the hybrid-tail threshold
  cached_at   INTEGER NOT NULL,
  last_access INTEGER,
  tier        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chunk_data_cache_eviction_idx
  ON chunk_data_cache (tier, last_access);
```

Write hook: `FsChunkDataStore.set()` upserts `size += chunk.length`,
`chunk_count += 1`. Read hook (`..._INDEX_UPDATE_ON_READ`): refresh
`last_access`. Note the caveat already documented for the contiguous index —
nginx absorbs a share of repeat reads (measured 53.2% hit rate on `/chunk/*` in
one window), so `last_access` is a best-effort demand signal.

## Rollout

Mirror the contiguous rollout, which is already proven operationally:

1. Ship the table + write hook first, evictor disabled. Verify the index tracks
   the filesystem.
2. `ENABLE_CHUNK_DATA_CACHE_INDEX_BACKFILL=true` for one pass, resumable via a
   per-shard checkpoint file. This is the _last_ full walk the cache ever needs.
3. Enable the evictor on one node; keep `FsCleanupWorker` available as an
   occasional reconciler.
4. Compare against the un-migrated node before rolling out.

Drift is tolerable for the same reason it is on the contiguous side: `statfs` is
authoritative for pressure, a stale row unlinks a missing file (ENOENT ignored),
and an unindexed file simply is not a candidate. Unlike the contiguous cache,
the chunk volume is XFS without compression, so logical byte counters equal
physical bytes.

## Scope: gateway cache only

`ar-io-node-indexer-core-1` mounts a **separate** chunk tree
(`caches/indexer/chunks`) on the spinning disk, not the NVMe LV measured here.
The indexer is therefore unaffected by this change, but it runs the same code:
enabling the evictor there is a distinct decision against an HDD-backed cache
with different traversal characteristics, and should not be assumed to follow
from a gateway rollout.

## Risks and Open Questions

- **Age floor (blocking).** Porting the contiguous evictor's "no age floor"
  semantics would allow eviction of unconfirmed chunks. Must be resolved before
  merge.
- **Large-dataRoot retention.** Does the hybrid tail threshold belong at p90
  (~79 chunks), or should very large dataRoots be per-chunk indexed outright?
  Needs a decision.
- **Index/FS drift has bitten us.** On gw2 the contiguous index was empty and
  its evictor freed 0 bytes per sweep; gw1 logged "Cache index drained but still
  over pressure; untracked files may need the FS reconciler" 51x per 2 h. The
  reconciler is not optional at chunk cardinality.
- **Derived reclaim figures are unreliable; measure directly.** An attempt on
  gw2 to infer the re-fetch rate as `distinct misses - (growth + deletes)`
  produced an implausible 78%, because the delete term counted only
  `FsCleanupWorker` log lines and missed `FsChunkDataStore.del()`. The
  `atime - mtime` sampling used above is the sound method; any future reclaim
  accounting should follow it rather than differencing counters.
- **`rmdir` is never called.** 67% of dataRoot dirs are empty. Reaping them is
  natural once eviction is dataRoot-scoped, but note `FsChunkDataStore.set()`
  does `mkdir` then `writeFile` with **no ENOENT retry** — removing a directory
  between those two calls silently drops the chunk. Any `rmdir` work must add
  that retry first.
- **`chunk_placements` staleness is inert today.** dataRoot-scoped eviction will
  unlink files that the optimistic-ingest index still has rows for.
  `getChunkPlacement` currently has no callers outside the database layer and
  tests, so a stale row is harmless and the two indexes do not need
  synchronising to ship. This should be re-checked if that accessor ever gains a
  caller on the serving path.
- **`by-absolute-offset` symlinks** are unaffected and still reaped by
  `SymlinkCleanupWorker`; dataRoot-scoped eviction will orphan more of them at
  once, so its interval may need review.
- **Write amplification** on `data.db` (2.9 GB, shared with other indexes) from
  the read hook. Per-dataRoot keying keeps the hot set small, but this should be
  measured, not assumed.

## Related

- [docs/cache-cleanup.md](../cache-cleanup.md) — the contiguous pattern this
  ports
- [docs/chunk-ingest-cache.md](../chunk-ingest-cache.md) — ingest/confirmation
  path
- PR #847 — disk-pressure watermarks for the chunk cache (the stopgap this
  supersedes)
