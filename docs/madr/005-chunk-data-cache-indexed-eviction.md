# Indexed Eviction for the Chunk Data Cache

- Status: accepted (implemented; rollout phases 1-2 verified against production
  data, phase 3 pending)
- Deciders: [Ariel, Phil]
- Date: 2026-08-19 (amended 2026-08-20 to match the as-built implementation)
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
5xx for several minutes. On 2026-08-20 the same failure reached its end state on
`turbo-gw-fsn1-2` (see the post-incident measurements below): 100% full, ~9
minutes from ENOSPC.

This ADR proposes porting the indexed-evictor pattern to the chunk cache, with
two chunk-specific departures that are **not** optional.

## Decision Drivers

- Eviction throughput must exceed the chunk write rate without operator tuning.
- Chunks pending seed confirmation must never be evicted (correctness, not
  perf).
- The design must fit the chunk cache's very different object-size distribution.
- Prefer reusing a pattern already proven in this codebase over inventing one.

## Measurements

All figures in this section from `turbo-gw-fsn1-1` (1 TiB XFS LV, NVMe),
2026-08-18/19, unless a subsection says otherwise. Sampling was bounded (random
prefix selection, capped `stat()` counts); no `du` or full-tree walk was run.

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

### Post-incident measurements: `turbo-gw-fsn1-2`, 2026-08-20

These were taken while the implementation below was being built, against the
live production tree on gw2. They are what moved this ADR from proposed to
accepted: they confirm the thesis, correct one of the methodology assumptions
above, and put numbers on the backfill and index-accuracy claims.

**The end state, and what a correctness-safe sweep recovers.** The volume
reached **100% (10 GB free), draining ~19 MB/s (~70 GB/hr net) — roughly 9
minutes from ENOSPC.** A manual sweep at the same age floor this design derives
(4 h) was run as
`find … -type f -amin +240 -mmin +240 -delete` — **files only, never `rmdir`**,
so it could not race `FsChunkDataStore.set()`'s `mkdir` -> `writeFile`. It freed
**778 GB** (1014G -> 236G used, 100% -> 24%) with **zero ENOSPC errors, zero
core errors and no service restart**; `nvme2n1` utilisation fell from 89% to
1.6%. The floor this ADR mandates is not merely affordable at full disk — it
is what made the emergency recovery safe.

**The walk-is-the-bottleneck thesis, confirmed under live pressure.** During
that same window `FsCleanupWorker` logged "No more files to delete, restarting
from the base path" while **86.7% of cached bytes were already past its own 2 h
age floor**. Eligibility was never the constraint; discovery was. A reclaimer
that cannot find the eligible bytes reports the cache as clean while the disk
fills.

**Methodology correction: bounded sampling under-estimates reclaimable bytes.**
A 150-directory sample predicted 41.5% of bytes reclaimable at the 4 h floor;
the actual figure was **78.8%** — a 1.9x under-estimate. The cause is the same
skew this design is built around: because the top 1% of dataRoots hold ~50% of
all chunks, **directory-count-weighted** sampling almost always misses the big
directories. Any future sampling of this tree must be **byte-weighted** (or
weighted by chunk count per dataRoot), not uniform over directories. The
`atime - mtime` method above remains sound; it is the _selection_ of
directories, not the per-file statistic, that was biased.

**Backfill, measured against the live tree.** A FULL pass over **128,969
dataRoot directories / 916,607 chunk files completed in 34.9 s**
(~242 dataRoot rows/sec sustained end to end), producing **8,437 rows covering
239.4 GB**. This is the concrete form of the "last full walk the cache ever
needs" claim in Rollout: half a minute, once, in the background, without
blocking startup.

**Index-vs-filesystem accuracy: 97.5%.** A random 400-dataRoot sample compared
the index row against a fresh `stat()` of the directory on
(`size`, `chunk_count`, `last_write`). 390/400 matched exactly. All 10
mismatches were **filesystem-newer-than-index** (chunks written after the walk
had already passed that directory); **none were index-newer-than-filesystem**.
That is the safe direction of drift: an under-counted row evicts a slightly
larger directory than it claims (bytes are recovered, `statfs` still governs the
stop condition) and, critically, an under-counted `last_write` is corrected
forward by the write hook's `MAX()` upsert the moment another chunk lands.

**The empty-directory problem is worse than the 67% measured on gw1.** After the
sweep, only **8,437 of 128,969** dataRoot directories are populated — **93.5%
are empty**, a **~15x readdir amplification** for any walker, because nothing
calls `rmdir`. `FsChunkDataStore.delDataRoot()` (added for the evictor) removes
the directory itself, so index-driven eviction shrinks this population over
time instead of growing it.

**As-built distribution on gw2** (corroborates the gw1 figures, same shape,
larger tail):

```
chunks per dataRoot   p50 2, p75 13, p90 101, p99 2,460, max 25,345

top  1% of dataRoots hold 50.5% of all chunks
top  5%                   84.5%
top 10%                   92.9%
```

p50 = 2 chunks and a max of 25,345 in the same population is precisely why
eviction must be size-aware rather than coldest-first, and why the hybrid-tail
threshold discussion below is not academic.

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

As built, this is `ChunkDataCacheEvictor` (`src/workers/chunk-data-cache-evictor.ts`),
`ChunkDataCacheReconciler` (`src/workers/chunk-data-cache-reconciler.ts`), the
write/read hooks and `delDataRoot()` in `src/store/fs-chunk-data-store.ts`, the
`chunk_data_cache` table in `chunks.db`, and the `CHUNK_DATA_CACHE_INDEX_*`
configuration block in `src/config.ts`.

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
it is configured shorter than the window it has to cover (values below are the
gw2 deployment's environment, not the shipped defaults):

```
CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS         =  7,200s (2h)   <- candidate floor
CHUNK_INGEST_CONFIRMATION_TIMEOUT_SECONDS           =  7,200s (2h)
CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS = 14,400s (4h)   <- longer
```

An allowlisted chunk therefore becomes evictable **two hours before its
confirmation window expires**. Measured confirmation is <=120 s, so the
practical exposure is small, but the timeout is the contract and eviction should
not violate it merely because the common case is fast. At the shipped defaults
(`CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` 3,600 s vs
`CHUNK_INGEST_ALLOWLIST_CONFIRMATION_TIMEOUT_SECONDS` 86,400 s) the same gap is
23 hours, which is why the floor is derived rather than configured.

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

**As built.** `deriveChunkDataCacheMinAgeSeconds()` in `src/config.ts` exports
exactly that formula, gated on `CHUNK_INGEST_CACHE_ENABLED` (when ingest caching
is off there is no locally-originated chunk to protect and the floor collapses
to `CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS`, the same floor the walk
worker honours). It is exposed as `CHUNK_DATA_CACHE_INDEX_MIN_AGE_SECONDS` and
is deliberately **not** readable from the environment. It is enforced twice: in
the SQL (`WHERE last_write <= @max_last_write`) and again per candidate in
`ChunkDataCacheEvictor.selectBatch()`, because a query that quietly stopped
filtering would fail silently. Candidates held back by the floor increment
`chunk_cache_index_skipped_floor_total`, which is what makes the protection
observable rather than invisible.

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

**As built.** Size-awareness shipped: a batch accumulates candidates until
`CHUNK_DATA_CACHE_INDEX_EVICTION_TARGET_BYTES` (default 1 GiB) is reached, so
one very large dataRoot ends a batch while a run of tiny ones does not. The
**hybrid tail did not ship.** `ENABLE_CHUNK_DATA_CACHE_INDEX_HYBRID_TAIL` and
`CHUNK_DATA_CACHE_INDEX_HYBRID_TAIL_CHUNK_THRESHOLD` (default 100, ~p90) exist
so the deployment surface is settled, but **nothing reads them today and
enabling the flag does nothing** — see Risks.

### Departure 3 (optional): tier by ingest origin

The contiguous evictor tiers by preferred-ArNS. The natural chunk analogue is
ingest origin: chunks POSTed by an allowlisted bundler
(`CHUNK_INGEST_CACHE_ALLOWLIST`) and not yet confirmed are tier 1; everything
cached by the read-through serving path is tier 0. Given that 64.5% of
serving-path chunks are never read again, tier 0 is where eviction should
concentrate anyway.

**As built.** The `tier` column and the `(tier, last_access)` index shipped with
the identical shape to the proven contiguous index, but every writer passes
tier 0 today (write hook, read hook, and backfill alike). Turning on
ingest-origin tiering later is therefore a code/config change, not a migration.

## Schema (as built)

Mirrors `contiguous_data_cache` so the evictor logic ports with minimal change,
with **one deliberate deviation** — `last_write` in place of `cached_at`:

```sql
CREATE TABLE IF NOT EXISTS chunk_data_cache (
  data_root    TEXT    NOT NULL PRIMARY KEY,  -- b64url, matches on-disk dir name
  size         INTEGER NOT NULL,              -- summed bytes of chunks under it
  chunk_count  INTEGER NOT NULL,              -- drives the hybrid-tail threshold
  last_write   INTEGER NOT NULL,              -- MAX(write time) — the age floor
  last_access  INTEGER,                       -- MAX(read time) — LRU order only
  tier         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chunk_data_cache_eviction_idx
  ON chunk_data_cache (tier, last_access);
```

It lives in `chunks.db`, not `data.db` — following the `chunk_placements`
precedent noted in the gw2 measurements, so eviction bookkeeping churns its own
WAL rather than a 2.9 GB shared database. `data_root` is TEXT (not BLOB, unlike
`chunk_placements`) because it must round-trip unchanged into the on-disk
directory name the evictor unlinks.

**Why `last_write` and not `cached_at`.** The proposed schema mirrored
`contiguous_data_cache`, where `cached_at` is the immutable first-write time.
Immutability is harmless per-blob; at dataRoot granularity it is a correctness
bug. Eviction is all-or-nothing per dataRoot, so a dataRoot first seen hours ago
that has _just_ received a fresh chunk would pass a `cached_at` age floor and be
evicted **whole**, taking the seconds-old, still-unconfirmed chunk with it. That
is exactly the silent upload-propagation failure Departure 1 exists to prevent —
and the floor would look correct in configuration while not actually holding.
The field is therefore MAX(write time) over every chunk under the dataRoot,
advanced on every upsert with
`last_write = MAX(last_write, excluded.last_write)`.

Write hook: `FsChunkDataStore.set()` upserts `size = size + excluded.size`,
`chunk_count = chunk_count + 1`, advancing `last_write` as above. It is
fire-and-forget: the index is an eviction accelerator, never a precondition for
caching, so an index failure must not fail a chunk write that already succeeded.

Read hook (`CHUNK_DATA_CACHE_INDEX_UPDATE_ON_READ`, default true): refreshes
`last_access` (and may raise `tier` with `MAX()`, never demote) and **must not
touch `last_write`** — a read is not a write, and letting reads advance the
floor would make a hot dataRoot permanently un-evictable under load. Note the
caveat already documented for the contiguous index — nginx absorbs a share of
repeat reads (measured 53.2% hit rate on `/chunk/*` in one window), so
`last_access` is a best-effort demand signal.

Backfill: `insertChunkDataCacheEntryIfAbsent` is
`INSERT … ON CONFLICT (data_root) DO NOTHING`.

## Rollout

Mirror the contiguous rollout, which is already proven operationally:

1. Ship the table + write hook first, evictor disabled. Verify the index tracks
   the filesystem. (Measured at 97.5% exact agreement on gw2; all drift in the
   safe direction.)
2. `ENABLE_CHUNK_DATA_CACHE_INDEX_BACKFILL=true` for one pass, resumable via a
   per-shard checkpoint file
   (`data/chunks/data/.chunk-cache-index-backfill-checkpoint`, written beside —
   not under — the walked subtree, at top-level-shard granularity). This is the
   _last_ full walk the cache ever needs; measured at 34.9 s for the whole gw2
   tree.
3. Enable the evictor on one node; keep `FsCleanupWorker` available as an
   occasional reconciler.
4. Compare against the un-migrated node before rolling out.

**Ordering safety (why steps 1-2 cannot corrupt each other).** The backfill
inserts with `ON CONFLICT DO NOTHING` while the write hook upserts with
`MAX(last_write, excluded.last_write)`. A backfill row can therefore never
clobber a fresher hook-written `last_write`, and a hook write that lands after
the walk has passed a directory only ever moves the floor **forward** —
regardless of how the two interleave. Both directions of the race are safe.
`src/system.ts` additionally double-gates the reconciler on **both**
`ENABLE_CHUNK_DATA_CACHE_INDEX` and `ENABLE_CHUNK_DATA_CACHE_INDEX_BACKFILL`, so
a backfill can never run while the write hook is disabled — which is what makes
seeding from a stale filesystem snapshot safe in the first place.

The backfill also seeds `last_write`/`last_access` from file `mtime`/`atime`,
never from the walk clock: seeding from walk time would make the entire cache
look uniformly freshly-written, put every row inside the age floor, and stall
eviction until the floor elapsed.

Drift is tolerable for the same reason it is on the contiguous side: `statfs` is
authoritative for pressure, a stale row unlinks a missing file (ENOENT ignored),
and an unindexed file simply is not a candidate. Unlike the contiguous cache,
the chunk volume is XFS without compression, so logical byte counters equal
physical bytes.

Observability: `chunk_cache_index_evicted_total`,
`chunk_cache_index_evicted_bytes_total`, `chunk_cache_index_entries`,
`chunk_cache_index_bytes`, `chunk_cache_index_backfilled_total`, and
`chunk_cache_index_skipped_floor_total` — a parallel metric family rather than a
label on `cache_index_*`, which is unlabelled by data type and would otherwise
collide with the contiguous evictor's series.

## Scope: gateway cache only

`ar-io-node-indexer-core-1` mounts a **separate** chunk tree
(`caches/indexer/chunks`) on the spinning disk, not the NVMe LV measured here.
The indexer is therefore unaffected by this change, but it runs the same code:
enabling the evictor there is a distinct decision against an HDD-backed cache
with different traversal characteristics, and should not be assumed to follow
from a gateway rollout.

## Risks and Open Questions

- **Age floor (blocking) — RESOLVED.** Implemented as the derived
  `CHUNK_DATA_CACHE_INDEX_MIN_AGE_SECONDS`, enforced in both the SQL and the
  evictor, and surfaced via `chunk_cache_index_skipped_floor_total`. See
  Departure 1.
- **Backfill emitted partial rows when aborted — RESOLVED (found in review,
  2026-08-20).** `aggregateDataRoot` checked `this.running` in its file loop but
  still returned the aggregate built so far, so a `stop()` landing part-way
  through a data-root directory indexed that data root from an incomplete file
  set. Under-counted `size`/`chunk_count` are benign (`statfs` is authoritative
  for pressure), but an under-counted **`last_write` is not**: it is the age
  floor, and a too-old value makes the row evictable *earlier* than it should
  be. Since eviction removes the whole data-root directory, a fresh — possibly
  still-unconfirmed — chunk that the walk never reached would be destroyed.

  Worse, it is not self-healing: backfill inserts with
  `ON CONFLICT DO NOTHING`, so a re-run never repairs the poisoned row, and only
  a subsequent write to that data root (which advances `last_write` via `MAX`)
  would fix it — a cold data root never gets one.

  Reproduced in test: aborting after the first `stat()` of a three-chunk data
  root yielded `{size: 4, chunkCount: 1, lastWrite: <4h older than the true
  max>}`. Resolved by discarding the aggregate entirely when `running` is false;
  emitting nothing is always safe, because an unindexed data root simply is not
  an eviction candidate. This is the same failure class as the `cached_at`
  deviation above: **any value that gates removal must be complete, or absent —
  never partially computed.**

- **The walk worker does not honour the derived floor (pre-existing, NOT
  introduced here).** `FsCleanupWorker` reclaims destructively with
  `CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` as its floor, independently of
  the ingest confirmation timeouts. Where that is configured below the longer
  confirmation window and ingest caching is on, the walk worker can already
  delete an unconfirmed chunk today — on `turbo-gw-fsn1-2` that is a 2h gap
  (aggressive 7200s vs allowlist timeout 14400s). Measured exposure is currently
  nil (confirmation is <=300s and no placement was observed unconfirmed beyond
  1.51h), but the contract is violated. Keeping the walk worker as the index
  reconciler therefore requires raising its floor to meet the derived one; see
  `docs/cache-cleanup.md`. Flagged here because this ADR is what makes the two
  reclaimers coexist by design.

- **Age floor at SELECT time is not sufficient — RESOLVED (found in review,
  2026-08-20).** The floor was originally applied only in the candidate query
  and re-checked in the evictor. Both happen at *selection* time, which leaves a
  TOCTOU window: the evictor selects a dataRoot while its newest write is old
  enough to evict, a chunk for that dataRoot lands before the delete runs, the
  write hook advances `last_write` — and because eviction unlinks the **whole
  dataRoot directory**, an unguarded `DELETE ... WHERE data_root = ?` reports one
  row changed and the evictor destroys the chunk that was just written. The
  poster received its 200; the bytes are gone. The age floor provides no
  protection here, because it was evaluated before the write existed.

  At roughly 99k chunk writes/hr with 1000-row eviction batches under sustained
  pressure, this window is hit in practice rather than theoretically.

  Resolved by re-applying the floor in the DELETE itself —
  `WHERE data_root = @data_root AND last_write <= @max_last_write` — mirroring
  the guard `deleteChunkPlacement` already uses (`AND confirmed_at IS NULL`) for
  exactly the same class of race. Deleting 0 rows is the safe outcome: the
  evictor unlinks only the dataRoots the DELETE actually removed, so a dataRoot
  written to in the gap keeps both its row and its bytes and is simply
  reconsidered next sweep. The evictor passes the same cutoff to both the SELECT
  and the DELETE, and there are regression tests at both the SQL layer and the
  evictor layer.

  Generalisation worth carrying forward: at dataRoot granularity, any check that
  decides *whether* a unit is safe to remove must be re-asserted at the moment of
  removal, because the unit is mutable between the two.

- **`cached_at` as the age-floor field — RESOLVED (schema deviation).** The
  proposed schema's `cached_at` (immutable on upsert, mirroring
  `contiguous_data_cache`) is a correctness bug at dataRoot granularity: because
  eviction is all-or-nothing per dataRoot, an old dataRoot that just received a
  fresh chunk would clear a `cached_at` floor and be evicted whole, dropping an
  unconfirmed chunk and breaking upload propagation **silently**. The shipped
  schema replaces it with `last_write` = MAX(write time) over the dataRoot's
  chunks, advanced by `MAX(last_write, excluded.last_write)` on every upsert;
  reads update `last_access` only and never advance it. See Schema (as built).
- **`chunks.db` WAL is never checkpointed (open; blocking for phase 3).**
  `StandaloneSqliteDatabaseWorker.cleanupWal` is typed
  `'core' | 'bundles' | 'data' | 'moderation'`
  (`src/database/standalone-sqlite.ts`) and only the `data` database is wired to
  a `SQLiteWalCleanupWorker` (`src/system.ts`, behind
  `ENABLE_DATA_DB_WAL_CLEANUP`). `chunks.db` is deliberately isolated with its
  own WAL — the point of putting `chunk_data_cache` there — but that also means
  a write-heavy `chunk_data_cache` grows `chunks.db-wal` **unbounded**, on the
  very volume this ADR is about. This must be addressed before the write hook
  runs at production write rates. The fix needs pool/db separation, not just a
  wider union type: there is no `chunks` worker pool, so `chunks.db` work routes
  through the `data` pool, while `cleanupWal` currently uses the single `dbName`
  argument as _both_ the queue target and the database to checkpoint.
- **Large-dataRoot retention / hybrid tail (open).** The hybrid tail did not
  ship: `ENABLE_CHUNK_DATA_CACHE_INDEX_HYBRID_TAIL` and
  `CHUNK_DATA_CACHE_INDEX_HYBRID_TAIL_CHUNK_THRESHOLD` are reserved and inert.
  Does the threshold belong at p90 (gw1 ~79 chunks, gw2 101), or should very
  large dataRoots be per-chunk indexed outright? Size-aware batching mitigates
  the "evicts nothing" half of the problem; the "single hot chunk pins a 2.69 GiB
  entry" half is still unaddressed. Needs a decision before the flag is wired.
- **Index/FS drift has bitten us.** On gw2 the contiguous index was empty and
  its evictor freed 0 bytes per sweep; gw1 logged "Cache index drained but still
  over pressure; untracked files may need the FS reconciler" 51x per 2 h. The
  reconciler is not optional at chunk cardinality. The chunk evictor
  distinguishes "index empty" from "everything is inside the age floor" in its
  logs precisely so this diagnosis is not ambiguous again.
- **Derived reclaim figures are unreliable; measure directly.** An attempt on
  gw2 to infer the re-fetch rate as `distinct misses - (growth + deletes)`
  produced an implausible 78%, because the delete term counted only
  `FsCleanupWorker` log lines and missed `FsChunkDataStore.del()`. The
  `atime - mtime` sampling used above is the sound method; any future reclaim
  accounting should follow it rather than differencing counters. Add to this:
  **sample by bytes, not by directory** — uniform directory sampling
  under-estimated reclaimable bytes by 1.9x on gw2 (41.5% predicted vs 78.8%
  actual) because the top 1% of dataRoots hold ~50% of the chunks.
- **`rmdir` is never called — PARTIALLY RESOLVED.** 67% of dataRoot dirs were
  empty on gw1; post-sweep on gw2 the figure is **93.5%** (8,437 populated of
  128,969), a ~15x readdir amplification. `FsChunkDataStore.delDataRoot()`
  now removes the directory, so index-driven eviction reduces the population
  over time. The prerequisite this created is real: `set()` does `mkdir` then
  `writeFile`, and removing the directory in between silently drops the chunk.
  The ENOENT retry that closes that window ships in PR #867 — **an image
  predating it must not run the evictor.**
- **`chunk_placements` staleness is inert today.** dataRoot-scoped eviction will
  unlink files that the optimistic-ingest index still has rows for.
  `getChunkPlacement` currently has no callers outside the database layer and
  tests, so a stale row is harmless and the two indexes do not need
  synchronising to ship. This should be re-checked if that accessor ever gains a
  caller on the serving path.
- **`by-absolute-offset` symlinks — MEASURED, interval needs review.** Eviction
  is data-root scoped and does not touch the absolute-offset symlink tree;
  `SymlinkCleanupWorker` reaps dangling links on a **24 h** default interval
  (`CHUNK_SYMLINK_CLEANUP_INTERVAL`). Measured on gw2 ~10 h after a 778 GB
  data-root-scoped reclaim: **15.6% of sampled absolute-offset symlinks were
  already dangling** (98 of 627 across 40 offset directories). Dangling links
  are not a correctness problem — `getByAbsoluteOffset` reads through the link,
  gets ENOENT and treats it as a cache miss, and a later chunk at the same
  offset is replaced atomically — but they hold inodes and cost a failed syscall
  plus a refetch until reaped. Operators enabling the evictor on a large chunk
  cache should shorten `CHUNK_SYMLINK_CLEANUP_INTERVAL` accordingly; 24 h leaves
  a substantial orphan population resident between sweeps.
- **Write amplification** from the read hook. Keeping the table in `chunks.db`
  removes the `data.db` exposure the proposal worried about, and per-dataRoot
  keying keeps the hot set small — but it relocates the cost onto the
  un-checkpointed WAL above rather than eliminating it. Still to be measured,
  not assumed.

## Related

- [docs/cache-cleanup.md](../cache-cleanup.md) — the contiguous pattern this
  ports, and the operator-facing guide to both chunk-side reclaimers
- [docs/chunk-ingest-cache.md](../chunk-ingest-cache.md) — ingest/confirmation
  path
- [docs/envs.md](../envs.md) — the `CHUNK_DATA_CACHE_INDEX_*` knobs
- PR #847 — disk-pressure watermarks for the chunk cache (the stopgap this
  supersedes)
- PR #866 — this ADR as proposed
- PR #867 — the `set()` ENOENT retry that makes directory removal safe (hard
  prerequisite for enabling the evictor)
