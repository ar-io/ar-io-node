# Change Log

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **Disk-pressure watermarks for the chunk data cache** —
  `CHUNK_DATA_CACHE_LOW_WATERMARK_PERCENT`,
  `CHUNK_DATA_CACHE_HIGH_WATERMARK_PERCENT`,
  `CHUNK_DATA_CACHE_MIN_FREE_BYTES` and
  `CHUNK_DATA_CACHE_AGGRESSIVE_MIN_AGE_SECONDS` bring the chunk cache cleanup
  walk in line with the contiguous data cache, which already had them. With a
  low watermark set the walk is skipped entirely while the filesystem has
  headroom, instead of running unconditionally. This matters on large caches
  atop spinning storage: the walk is metadata-bound, so a tree with tens of
  millions of inodes cannot be traversed within
  `FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION` — a pass never completes and the
  device stays saturated even with terabytes free. Previously the only escape
  was `ENABLE_CHUNK_DATA_CACHE_CLEANUP=false`, which stops reclamation
  altogether and lets the cache grow unbounded. All four default to the
  existing behavior, so nothing changes unless they are set.

- **Leader re-election on a failed foreground fetch** — a leader that fails
  releases every waiter at once, and each of them then started its own fetch in
  the same tick. That is the same total work as no coalescing at all, delivered
  as one synchronised burst instead of spread across the arrivals that produced
  it -- strictly a worse shape than the problem coalescing was added to fix.

  A waiter released by a *failure* now re-enters with one attempt spent: the
  first back through finds the ID unowned and claims it, and the rest attach to
  that new leader. `FOREGROUND_CACHE_COALESCE_MAX_ATTEMPTS` (default 2, minimum
  1) bounds the chain so a succession of dying leaders cannot park a request
  indefinitely; 1 restores the previous behavior exactly.

  Re-election is deliberately limited to failures. The in-flight promise now
  reports `cached` / `uncached` / `failed` rather than a bare boolean, because
  the old `false` conflated three endings. A leader that succeeded but declined
  to cache (size cap, concurrency cap, zero-length, writes disabled) would be
  followed by a new leader declined by the same policy, and a leader that timed
  out still owns its map entry, so re-attaching would wait on the fetch just
  abandoned. Both send the waiter straight to its own fetch. Re-elections are
  visible as `foreground_cache_coalesced_outcome_total{outcome="re_electing"}`.

- **A size floor on foreground coalescing** — `FOREGROUND_CACHE_COALESCE_MIN_SIZE`
  exempts objects known to be smaller than it, which then fetch for themselves
  exactly as they did before coalescing existed. Coalescing serves a waiter
  from the blob the leader finalizes, so it costs that waiter the whole
  download in time-to-first-byte. That is worth paying on a multi-gigabyte
  object whose duplicates are measured in gigabytes; it is a poor trade on a
  small one that duplicates cheaply and finishes fast.

  Sized against the production stampede above: objects over 1 GiB were 94.8%
  of the redundant bytes and everything under 100 MiB was 0.2%, so a 100 MiB
  floor there would have retained 99.83% of the reclaimed bytes (223.6 of
  224.0 GB) while leaving about half of all staged objects, by count,
  streaming independently.

  **Defaults to 0 — no floor — so behavior is unchanged unless it is set.**
  The size compared is the one already resolved from the attributes store at
  the point coalescing is decided; `data.size` is not available until the
  upstream fetch returns, which is after a leader has claimed the ID. An
  object of unknown size is therefore treated as eligible, so the floor can
  only narrow coalescing where an object is positively known to be small and
  can never make stampede protection weaker than leaving it unset. Exemptions
  are counted as `foreground_cache_skipped_total{reason="below_coalesce_floor"}`;
  compare it against `already_pending` to judge whether the floor is too high.

- **Bounds on foreground cache writes** — `FOREGROUND_CACHE_MAX_SIZE` and
  `FOREGROUND_CACHE_CONCURRENCY` cap how much unfinished data a burst of
  *distinct* large objects can accumulate in `contiguous/tmp`, mirroring the
  guards background range caching already had. Exceeding either serves the
  request normally and skips only the cache write. The concurrency budget is
  process-wide, shared by the on-demand and background caches, because both
  stage to the same directory.

  **Both default to unbounded, deliberately.** Coalescing alone removes the
  duplication of *identical* objects and needs no configuration, but a burst
  of *distinct* large objects is only bounded once these are set -- upgrading
  does not inherit that protection. Any finite default would silently stop a
  busy gateway caching most of what it serves, which is not a change to make
  on an operator's behalf; set them explicitly per deployment.

### Changed

### Fixed

- **Concurrent requests for one uncached object no longer stampede** — on a
  full-object cache miss `ReadThroughDataCache.getData` ran an upstream fetch
  and opened a staging file per request, with nothing checking whether a fetch
  for the same ID was already running. Seen in production as 59 concurrent
  partial copies of one 1.5 GB bundle: 1,434 open descriptors under
  `contiguous/tmp`, ~253 GB staged across only 18 distinct objects of which
  83% was redundant. It is self-amplifying — the duplicated writes saturate
  the disk, so no copy finishes, so every new request is also a miss and
  starts another copy. The first caller for an ID is now the sole owner of the
  fetch, the staging file and the tee; concurrent callers wait on it rather
  than starting their own. When it finalizes they are served from the blob it
  wrote. When it does not -- it failed, or it stalled past
  `FOREGROUND_CACHE_COALESCE_TIMEOUT_MS` (default 300000) -- there is no
  shared blob to serve, so each waiter falls back to fetching independently,
  which is the pre-existing behavior for exactly that case. Those two
  outcomes are visible as `refetched` and `timed_out` on
  `foreground_cache_coalesced_outcome_total`. Waiters hold no reference to
  the shared fetch, so one aborting can neither cancel it nor orphan its
  staging file, and the timeout keeps a stalled fetch from parking later
  requests for that ID indefinitely.

  **Operator note — the cache-miss signal for this failure is gone.** A
  coalesced request is served from the cache, so it now reports the same
  cache-hit semantics as a request arriving a moment later (`X-Cache: HIT`,
  `Content-Digest`, conditional-request eligibility) and counts as a hit
  rather than a miss. Hit-rate dashboards will move, and more importantly
  `contiguous_data_cache_miss_total` no longer rises when many requests
  converge on one uncached object -- which was the signal this failure mode
  used to produce. Use `foreground_cache_skipped_total{reason="already_pending"}`
  to detect recurrence instead: it counts exactly the requests that would
  previously have started a duplicate fetch, so a sustained rise is the
  stampede re-forming. `foreground_cache_coalesced_outcome_total{outcome}`
  breaks those down into `cache_hit` (the leader cached, waiter served from
  disk), `refetched` (the leader cached nothing) and `timed_out` (the leader
  stalled past the bound).

  The fix also **converts** part of the load rather than removing it: the
  leader writes once, then each waiter opens its own read of the finalized
  blob (measured: 49 reads for 50 concurrent requests). That is the same
  shape as N concurrent requests for an already-cached object, and far
  cheaper than N concurrent multi-GB writes, but the reads all begin at the
  moment the leader finalizes rather than being spread over time.

## [Release 82] - 2026-08-13

This is a **recommended release** focused on **data-retrieval correctness and
outbound connection health**. Key highlights include a new
`GET /ar-io/offsets/:id` endpoint that serves root transaction offsets straight
from the local index, with a matching `peers` lookup source so a miss costs the
peer one indexed read instead of a full retrieval cascade; detection and repair
of mis-rooted data items, whose stored root could be an intermediate bundle and
so sent chunk retrieval after chunks that cannot exist; keep-alive pooling and
per-host socket caps for outbound clients, removing a per-request DNS lookup
that queued behind filesystem I/O; configurable SQLite read workers with
queue-wait and slow-query instrumentation; GraphQL routing that steers
owner-filtered and L1-only queries away from ClickHouse row-cap failures; and an
opt-in SSD-resident cache index with a disk-pressure evictor for large
spinning-disk caches. It also fixes an offset-index scan that could pin a read
worker for minutes on a miss, an Envoy route timeout that cut GiB-scale
downloads mid-stream, and a Docker build context that could exhaust the daemon's
disk and take down every container on the host.

### Added

- **Root TX offsets endpoint** — new `GET /ar-io/offsets/:id` serves a data
  item's position inside its root transaction straight from the local index,
  without touching contiguous data. The previous way to ask a peer for offsets
  was `HEAD /raw/:id`, whose headers are a byproduct of a successful retrieval:
  on a cache miss the peer walked its whole `ON_DEMAND_RETRIEVAL_ORDER` cascade
  before answering. Offsets now resolve for any item the node has unbundled and
  indexed, including items with no bytes cached locally. A matching `peers`
  lookup source (`PEERS_ROOT_TX_URLS`, selectable in `ROOT_TX_LOOKUP_ORDER`)
  consumes it, with priority tiers, per-peer rate limits, and a shared LRU.
  There is no `HEAD /raw` fallback by design — compose one explicitly with
  `db,peers,gateways,...` (#837, PE-9135).
- **SSD-resident cache cleanup index and disk-pressure evictor** — an
  alternative reclaimer for the contiguous data cache that keeps eviction
  discovery off the HDD. A `contiguous_data_cache` table records
  `{hash, size, cached_at, last_access, tier}` per cached blob; an interval
  sweep driven by `statfs` evicts least-recently-accessed first, general tier
  before preferred, and drains to the low watermark. Reads refresh
  `last_access` and promote a blob's tier on a preferred-ArNS hit
  (`CONTIGUOUS_DATA_CACHE_INDEX_UPDATE_ON_READ`, default `true`; set `false`
  for FIFO). A resumable one-time backfill adopts a pre-existing cache. Off by
  default (`ENABLE_CONTIGUOUS_DATA_CACHE_INDEX`); see the new
  `CONTIGUOUS_DATA_CACHE_INDEX_*` env vars and `docs/cache-cleanup.md`
  (#823, PE-9131).
- **`PUT /ar-io/admin/unblock-data` admin endpoint** — lifts a data block
  created with `block-data`, by `id` or `hash`. Moderation previously had
  `block-data`, `block-name`, and `unblock-name` but no way to reverse a data
  block short of editing `moderation.db` by hand. Idempotent; blocked data is
  checked per request, so an unblock takes effect immediately (#821).
- **GraphQL `owner_projection` routing** — owner-filtered `transactions`
  queries can be routed through the owner-ordered projection instead of the
  height-ordered main table, where a sparse owner's rows scatter across
  millions of granules and can trip the ClickHouse row cap. Covers no-id owner
  queries (with a reactive height-windowing fallback) and `owners + ids`
  queries. Off by default; see
  `CLICKHOUSE_GQL_OWNER_PROJECTION_ROUTING_ENABLED` and
  `CLICKHOUSE_GQL_OWNER_PROJECTION_ENTITY_TYPES` (#796, #800).
- **GraphQL L1-only query routing** — `GQL_L1_ONLY_ROUTING_FILTER` classifies
  which `transactions` queries are provably confined to the base layer and
  answers them from the SQLite `stable_transactions` tag PK seek, skipping
  ClickHouse and its `max_rows_to_read` cap entirely. Uses the composable
  filter DSL restricted to its monotone subset; `not`, `isNestedBundle`, and
  `hashPartition` are rejected at startup. The filter is an operator assertion
  — routed queries intentionally exclude bundled data-item matches. Default
  `{"never": true}` (off). New `graphql_l1_only_routing_total` metric (#810).
- **Configurable SQLite read workers and queue instrumentation** — reads were
  serialized in one worker thread per pool. `CORE_SQLITE_READ_WORKER_COUNT`
  (default `1`) and `DATA_SQLITE_READ_WORKER_COUNT` (default `2`) add read
  concurrency. Queue wait and service time are now separate metrics
  (`standalone_sqlite_method_queue_wait_seconds` vs `..._service_seconds`), and
  `SQLITE_SLOW_QUERY_LOG_THRESHOLD_MS` (default `1000`) logs slow operations
  with a queue/service breakdown to identify the responsible method during a
  jam (#817).
- **Per-host outbound socket caps and socket-acquisition instrumentation** —
  `GATEWAY_MAX_SOCKETS_PER_HOST` (default `16`),
  `GATEWAY_UNTRUSTED_MAX_SOCKETS_PER_HOST`, and
  `GATEWAY_MAX_FREE_SOCKETS_PER_HOST` (default `4`) bound outbound concurrency
  per gateway host, each accepting a bare integer or a per-host object. Trusted
  and untrusted gateways get separate caps so a CDN-fronted upstream is not
  overwhelmed. New `gateway_socket_acquisition_seconds` and
  `gateway_socket_connect_seconds` metrics (the latter now includes the TLS
  handshake for https gateways) plus a slow-acquisition warning
  (`GATEWAY_SLOW_SOCKET_ACQUISITION_LOG_THRESHOLD_MS`) surface pool waits
  before a request reaches the wire.
- **Connection pooling for non-data outbound clients** — root TX discovery
  sources and the GraphQL fan-out now share keep-alive agents
  (`OUTBOUND_MAX_SOCKETS_PER_HOST`, `OUTBOUND_MAX_FREE_SOCKETS_PER_HOST`). The
  goal is not throughput but avoiding a per-request `dns.lookup()`, which
  queues on the libuv threadpool behind filesystem I/O and can time out before
  a socket opens. Watch `outbound_socket_acquisition_seconds{reused="false"}`
  (#840, PE-9136).
- **Envoy circuit breakers for the core cluster** — `max_connections`,
  `max_pending_requests`, and `max_requests` for `ario_gateways` now default to
  `16384` instead of Envoy's `1024`, with a retry budget
  (`ENVOY_ARIO_GATEWAY_RETRY_BUDGET_PERCENT`, default `20`) replacing the
  default `max_retries` of 3. At Envoy's defaults a slow core pinned the pool,
  further requests failed instantly with `reset reason: overflow` (503), and
  client retries kept it pinned so the cluster never drained (#841).
- **Manifest resolution metrics** — the two resolution sites in the data
  handler are now instrumented. `manifest_resolutions_total{source,
  resolution_type}` splits resolutions by source (`index` = served from the
  resolution index without parsing the body, `data` = on-demand body parse) and
  by outcome (path / index / fallback / unresolved); the index-vs-data ratio is
  the effectiveness signal for the index and its cache.
  `manifest_unresolved_root_total` counts root/index requests that resolve to
  nothing — a malformed-manifest signal that previously surfaced only as a user
  404. `manifest_resolution_duration_seconds{source}` records latency by source
  (#835).
- **ClickHouse `TOO_MANY_ROWS` observability** — Code 158 responses are now
  logged and counted at the origin, so row-cap failures are attributable to a
  query shape instead of surfacing only as GraphQL errors (#816).
- **`TRUSTED_GATEWAYS_SEND_UNTRUSTED_PARAMS` kill-switch** — set `true` to
  restore the legacy behavior of sending `ar-io-*` provenance query params to
  every gateway (see Changed) (#798).
- **Dedicated Turbo AWS client** — the Turbo S3 data source can use its own
  credentials and endpoint via `TURBO_AWS_REGION`, `TURBO_AWS_ENDPOINT`, and
  the optional `TURBO_AWS_*` credential vars. The client is created only when
  both region and endpoint are set; otherwise the default AWS client is reused
  (#794, PE-9125).
- **Opt-in chunk over-propagation** — `CHUNK_POST_CONTINUE_PAST_THRESHOLD`
  (default `false`) keeps broadcasting a chunk to every selected peer after the
  success threshold is met, maximizing redundancy instead of stopping early. The
  dead-peer tail stays bounded by `CHUNK_POST_MAX_CONSECUTIVE_FAILURES`; pair it
  with a higher `CHUNK_POST_PEER_CONCURRENCY` so broadcasts complete promptly. A
  new `arweave_chunk_post_temporary_total` metric exposes the 200-vs-303
  acceptance split (#819).

### Changed

- **Untrusted gateways no longer receive `ar-io-*` provenance query params** —
  gateways configured with `"trusted": false` in `TRUSTED_GATEWAYS_URLS` now get
  provenance via `X-AR-IO-*` headers only. Required for CDN-fronted gateways
  such as `arweave.net`, whose CDN returns 502 on those query params. Revert
  with `TRUSTED_GATEWAYS_SEND_UNTRUSTED_PARAMS=true` (#798).
- **Local-first root TX offset resolution** — `RootParentDataSource` now
  resolves offsets from the local index before consulting remote sources, and
  the composite lookup short-circuits as soon as a source returns an actionable
  result instead of polling the rest of `ROOT_TX_LOOKUP_ORDER`. Callers can pass
  an `accept` predicate to define what counts as actionable (#827, #828, #829,
  PE-9134).
- **Offset-to-block resolution runs locally** — locating the block that
  contains an absolute offset used a chain binary search of roughly
  `log2(height)` sequential `GET /block/height/{h}` calls to the trusted node
  (~1.5s each), often exceeding `CHUNK_SERVE_DEADLINE_MS` and returning 504.
  A local index over `stable_blocks.weave_size` is consulted first and trusted
  only under a tight bracket, with re-verification and a fallback to the chain
  search on any gap, stale index, or unstable-tip offset. The block returned is
  identical. New `block_offset_resolution_total` metric (#801, #807).
- **Idle outbound gateway sockets are retired before the peer closes them** —
  `GATEWAY_AGENT_IDLE_SOCKET_TIMEOUT_MS` (default `50000`) must stay below the
  peer's server keep-alive timeout (`HTTP_KEEP_ALIVE_TIMEOUT_MS`, default
  `60000`). Reusing a socket the server is simultaneously closing caused ~8-10s
  peer-fetch stalls.
- **Chunk-post fan-out narrows to the configured threshold** — now that HTTP 303
  counts as a successful (temporary) acceptance (see Fixed), broadcasts stop at
  `CHUNK_POST_MIN_SUCCESS_COUNT` as intended instead of grinding the full peer
  list. Operators who relied on the prior 303-handling bug's accidental wide
  spread can restore it with `CHUNK_POST_CONTINUE_PAST_THRESHOLD=true` (#819).
- **Default observer image bumped to `15e285b0`** — `OBSERVER_IMAGE_TAG` moves
  from `308b6777` (2026-06-20) to the current `ar-io-observer` release build,
  picking up the full ArNS lease lifecycle in the epoch cranker, adaptive
  cranker poll/cleanup intervals derived from epoch duration, the
  `LeaveWindowNotExpired` (6079) not-ready classification, failed-gateway
  summary attribution fixes, and `@ar.io/sdk` 4.1.0 (stable, mainnet). It also
  raises ArNS prune throughput: `prune_name_to_returned` is the only
  deadline-bound step in the lease lifecycle, and draining one name per scan
  capped conversion at roughly the rate leases expire, so any backlog was
  permanent and each name aging out of its return-auction window lost that
  auction for good. `CRANK_POLL_INTERVAL_MS` and `CLEANUP_MIN_INTERVAL_MS` are
  now optional — unset, the cranker derives them from the epoch duration; an
  explicit value still wins. Those two plus the new
  `CLEANUP_TO_RETURNED_TXS_PER_CYCLE` (default `10`) are now forwarded to the
  observer container so they can be set from `.env`; leaving them empty keeps
  the derived default. Operators who pin `OBSERVER_IMAGE_TAG` in `.env` must
  update it there too, since that shadows the compose default (#842, #845).
- Test files are now typechecked in CI (#809).

### Fixed

- **Background verification no longer withholds unmined data when optimistic
  indexing is off** — the serving guard withheld verification whenever the root
  transaction had a `NULL` height, reading that as "optimistically indexed, not
  yet mined". That meaning only holds when optimistic L1 transaction indexing is
  what creates `NULL`-height rows. With `OPTIMISTIC_TX_INDEXING_ENABLED` false
  (the default), a `NULL` height means only that this node has not imported the
  transaction's block — routine for transactions indexed via
  `admin/queue-tx`, backfills, or any selectively synced deployment. The result
  was permanent, silent starvation: withholding burns no retry, so the item
  never aged out, and the log is debug-level, so nothing surfaced. The guard is
  now gated on the feature that justifies it (#855).
- **Observer cranker settings reachable from `.env`** — `CRANK_BATCH_SIZE`,
  `CRANK_CLOSE_EPOCHS`, `CRANK_EPOCH_RETENTION`, `CRANK_WARN_BALANCE_SOL`,
  `CRANK_CRITICAL_BALANCE_SOL`, `CLEANUP_BATCH_SIZE`,
  `CLEANUP_FAILURE_THRESHOLD`, `MAX_CLEANUP_TXS_PER_CYCLE`,
  `ALT_RECLAIM_SCAN_LIMIT` and `OBSERVED_GATEWAY_HOSTS` are read by the observer
  but were never passed into its container, so setting them in `.env` had no
  effect. Forwarded with the established empty-default pattern and documented,
  completing what #842 (poll/cleanup intervals) and #846 (prune budget) started.
  An empty value resolves to each setting's existing default, so nothing changes
  unless an operator sets one (#857).
- **Chunk POST treats HTTP 303 ("temporary") as success** — Arweave tip/ingress
  nodes return 303 when they validate and persist a chunk into their disk pool
  without being its long-term home (`ar_disk_pool:add_chunk/6 -> temporary`).
  Previously counted as a failure, which returned spurious errors to uploaders,
  undercounted broadcast success, and (since 303 is not a 4xx) defeated the
  consecutive-failure early exit — grinding the full non-preferred peer list
  (p95 ~33s). 303 now counts toward the overall and preferred success
  thresholds (#819).
- **Chunk metadata cache keyed by the full data root** — metadata was bucketed
  by only the first four base64url characters of the data root plus the relative
  offset, so transactions whose data roots share a 4-character prefix shared
  slots. Relative offset 0 collides constantly, and the read path served one
  transaction's `data_path` for another, failing merkle validation with
  "Failed to parse data_path: invalid proof" until the entry was removed by
  hand. The full data root is now in the path, with a read-time `data_root`
  check that deletes mismatches and treats them as misses (#820, PE-9129).
- **Zero-length chunk cache poison is rejected and self-healed** — nothing
  validated chunk length, so a source that once returned an empty chunk was
  persisted and re-served forever: `has()` reported a hit on the 0-byte file,
  `get()` served an empty chunk, and the streaming loop never advanced,
  re-requesting the same offset indefinitely. Every layer now refuses to persist
  and refuses to serve zero-length chunks, deleting the poisoned file on read.
- **Chunk streaming guarded against non-terminating loops** — a stream that
  stops making forward progress now fails instead of spinning (#799, PE-9127).
- **Optimistic chunk confirmation is sticky per `data_root`** — confirmation
  was a one-shot `UPDATE` fired by `TX_INDEXED` that only touched placements
  present at that instant. A multi-GB bundle streams its chunks in over a far
  longer window, so most arrived afterwards, were never confirmed, and hit the
  ingest TTL — leaving a gappy, unservable set that fell through to peers which
  did not yet have the bundle. Chunks ingested after the confirm event now
  self-confirm, with markers pruned by a GC sweep
  (`CHUNK_INGEST_CONFIRMED_ROOT_RETENTION_SECONDS`, default `3600`) (#815).
- **`getTxByOffset` misses no longer scan the offset index to the end** — the
  span predicate sat inside the index scan, so a miss (an offset in a coverage
  gap) walked `stable_transactions_offset_idx` from the offset to the end of the
  table with a row fetch per entry — tens of seconds to minutes on a
  production-sized DB (up to 110s observed), each one pinning a read worker and
  holding the requesting peer's socket. A miss now costs the same single index
  probe as a hit (#818).
- **`MAX(stable_blocks.block_timestamp)` no longer full-scans** — the query ran
  over ~2M rows (~900 MB) with no index. Called infrequently, the pages fell out
  of the page cache between calls and the scan became disk-bound, holding the
  core read worker — and, inline in `saveBlockAndTxs`, the write worker — for
  8-13s on busy hosts. Now a covering reverse index seek (#822, PE-9130).
- **Apex `/raw` no longer times out mid-stream** — the `root_service` catch-all
  inherited Envoy's default 15s route timeout, an absolute cap on total request
  duration regardless of whether the body was still streaming, so large objects
  streamed to normal-speed clients were reset (HTTP/2 `RST_STREAM CANCEL`, curl
  92). Clients finishing under 15s were unaffected, which made it look
  intermittent. `/raw/` now gets a dedicated `timeout: 0s` route mirroring the
  sandbox data route; the catch-all keeps its finite default for small endpoints
  (#826, PE-9132).
- **Truthful `hasNextPage` when id-dedup collapses a full ClickHouse page** —
  windowed `transactions` queries could return a partial page with
  `hasNextPage: false` and no error, silently stranding every subsequent page.
  The ClickHouse legs fetch `pageSize + 1` rows with a full-key `LIMIT 1 BY`,
  but the composite deduped by `id` alone; stale rows sharing an `id` and height
  while differing on `block_transaction_index` collapsed only in the id-dedup,
  making a full leg look short (#792, PE-9124).
- **`bundledIn` queries are never routed to the L1-only path** — routing them
  would drop every data-item result the query exists to return (#810).
- **Mis-rooted data items are detected and repaired on retrieval** — a stored
  root transaction ID is not always an L1 transaction. When the parent chain
  was incomplete as offsets were computed, the traversal stopped at the first
  ancestor it held no attributes for — often an intermediate bundle — and
  persisted that as the root; the pre-computed short-circuit then returned it
  forever without validating it. Chunk retrieval requires an L1 transaction, so
  a bundled root sent `TxChunksDataSource` after chunks that cannot exist,
  polling up to `ARWEAVE_PEER_CHUNK_GET_MAX_PEER_ATTEMPT_COUNT` peers at ~90s
  per request before the tier gave up and the request 404'd. The stored root is
  now validated locally and, when itself bundled, walked to the real root with
  offsets rebased by each parent's payload offset. The correction is persisted
  only when the chain resolves fully to an L1 transaction, and the traversal
  fallback no longer persists a root inferred from an unindexed ancestor — that
  guess is what mis-rooted items in the first place. A chain that cycles
  discards the partial rebase and returns the stored pair unchanged, since a
  half-rebased root is worse than an uncorrected one. New
  `root_tx_stored_root_rebased_total{outcome}` metric with `resolved`,
  `incomplete`, and `lookup_failed` outcomes (#843).
- **Attribute-write dedupe keyed on the root coordinates** —
  `saveDataContentAttributes` deduped on the data item ID alone with a 7-minute
  TTL, so whichever writer arrived first won and every later write for that ID
  was discarded regardless of what it carried. A retrieval that beat
  `RootParentDataSource` re-wrote the existing root attributes unchanged and
  claimed the slot, so a corrected root arriving inside the same window was
  thrown away and the row stayed mis-rooted until the entry expired. The key
  now includes the three root fields, so a write that changes nothing is still
  suppressed while a genuine correction always reaches the queue. Observed on a
  canary gateway: 346 suppressed duplicate calls in ~40 minutes, and a
  confirmed rebase onto the L1 root dropped because an unchanged write had
  landed 65 seconds earlier. `clearDataHash` now invalidates every dedupe key
  belonging to an item, so the re-save after a verification mismatch is no
  longer suppressed and the row is not left with a null hash (#843).
- **Git worktrees excluded from the Docker build context** — `./tools/wt add`
  creates worktrees under `wt/`, each with its own `node_modules` and `data/`,
  and nothing excluded them. Measured on one gateway, `wt/` alone was 31 GB
  across 9 worktrees, taking the build context from ~2.5 GB to over 30 GB;
  combined with accumulated build cache that exhausted the daemon's disk
  part-way through `COPY`, which crashed dockerd and SIGKILLed every running
  container. `COPY . .` drops to ~0.4s on that host after the change. `logs/`
  is deliberately *not* excluded: `logs/.gitkeep` is tracked and the winston
  file transport does not create the directory, so excluding it breaks running
  the test suite inside a container (#844, #846).
- Outbound keep-alive agents created by a client are now destroyed on cleanup,
  and free sockets default to the active cap so pooled connections are actually
  reused (#840, PE-9136).

### Removed

- Dead `ARWEAVE_PEER_CHUNK_POST_*` env vars, which had no remaining effect
  (#795).

## [Release 81] - 2026-06-20

This is a **recommended release** focused on **optimistic ingest and
data-serving reliability**. Key highlights include an optimistic chunk ingest
cache that verifies and serves freshly-posted chunks from local storage before
they are fetched upstream, and optimistic L1 transaction indexing that makes
signed transactions queryable before they mine (both off by default); admission
control — depth-based backpressure and per-request batch caps — on the admin
ingest endpoints so a high-volume bundler gets retryable responses instead of
overrunning the indexer; a wall-clock deadline on chunk serves so slow
retrievals fail fast as 404s rather than hanging; and a GraphQL owner-key cache
with in-flight request coalescing plus batched root-tx lookups to cut upstream
rate-limiting.

### Added

- **Optimistic chunk ingest cache** — verify and optimistically cache chunks on
  `POST /chunk`, then serve and unbundle them from local cache before fetching
  upstream. Unconfirmed chunks are reclaimed by a GC sweep and bounded by a
  synchronous pending-bytes disk cap. Off by default
  (`CHUNK_INGEST_CACHE_ENABLED`); see the new `CHUNK_INGEST_*` env vars.
- **Optimistic L1 transaction indexing** — new admin endpoint
  `POST /ar-io/admin/queue-optimistic-tx` indexes signed L1 transaction headers
  before they mine, making them queryable immediately; a serving guard withholds
  `verified` until the transaction is mined. Off by default
  (`OPTIMISTIC_TX_INDEXING_ENABLED`); see the new `OPTIMISTIC_TX_*` env vars and
  MADR 004.
- **Admission control on `POST /ar-io/admin/queue-data-item`** — a per-request
  batch-size cap (`400`) and indexer-depth backpressure (`503` + `Retry-After`),
  with the body limit raised to 10 MB, so a bundler burst gets a retryable
  response instead of unbounded queue growth. New `QUEUE_DATA_ITEM_MAX_BATCH_SIZE`
  / `QUEUE_DATA_ITEM_BACKPRESSURE_DEPTH`; `data_item_queue_rejected_total{reason}`
  metric.
- **Wall-clock deadline for chunk serves** — chunk retrieval is bounded by a
  wall-clock deadline; timeouts return `404` instead of hanging (PE-9121).
- **GraphQL owner-key cache** — address-keyed owner-key cache with an in-flight
  request coalescer, plus observability metrics (PE-9120).
- **Batched GraphQL root-tx lookups** — discovery batches root-tx lookups to
  avoid upstream rate-limit 404s (PE-9108).
- **Parquet export resilience** — DuckDB sorts spill to disk to survive dense
  partitions, with configurable DuckDB memory/thread limits (wired into compose)
  and real export errors surfaced instead of swallowed.

### Changed

- Aligned keepalive timeouts across envoy and core to prevent mid-request
  connection resets (PE-9122).
- Envoy chunk-retry behavior — conservative retry on the chunk route; stop
  retrying chunk GET/HEAD serves against a single-endpoint core (PE-9121).
- Decoupled contiguous-cache cleanup initial delay from the cleanup threshold
  (PE-9106).
- Bounded unbundling retries and cooldowns to prevent runaway loops.
- Observer now receives assessment-concurrency and log-report-sink config.
- Updated the bundled observer image to a stable `@ar.io/sdk` (`4.0.3`) build,
  including the Solana epoch-cranker `finalize_gone` window-eligibility fix and
  the report-sink failure-threshold adjustment.

### Fixed

- Chunk-retrieval 5xx classification and terminal error handling so serve
  failures surface cleanly (PE-9121).
- GraphQL data-item `owner.key` misses now coerce to a NOT_FOUND sentinel
  instead of erroring.
- Validate numeric env vars (optimistic-tx, retry caps, root-tx batch) at parse
  time to guard against NaN misconfiguration.

## [Release 80] - 2026-06-06

This is a **recommended release** focused on the **AO → Solana
migration** of AR.IO protocol state, **Solana-native observation and
HTTPSIG signing**, and **data-integrity hardening**. Key highlights
include reading the Gateway Address Registry, ArNS/ANT records,
epochs, and prescribed observers from Solana on-chain programs via
`@ar.io/sdk` 4.0.0 (#709, #765); a Solana observer that signs and
submits `save_observations`, uploads its report bundle, and can run
the permissionless epoch cranker (#709); response trust headers
signed directly with the observer's Solana key (#758); mainnet
program IDs defaulted so a fresh mainnet deploy starts the observer
out of the box (#766); the Solana 4.0.0 observer container wired in
as the default image (#767); and a fix preventing L1 transactions
with an empty/NULL `data_root` from serving unrelated content (#755).

### Added

- **Solana protocol backend — AO → Solana migration (#709)**: The
  gateway now reads all AR.IO protocol state — the Gateway Address
  Registry, ArNS names and ANT records, epochs, prescribed
  observers, and observation status — from Solana on-chain programs
  via `@ar.io/sdk`'s Solana backend, replacing the AO compute-unit
  reads. Configured by `SOLANA_RPC_URL` (defaults to mainnet-beta;
  use a dedicated provider in production) and the `ARIO_CORE_/GAR_/
  ARNS_/ANT_PROGRAM_ID` env vars (default to the mainnet program
  IDs). The `OnDemandArNSResolver` routes ANT lookups through
  `SolanaANTReadable`.
- **Solana observer, cranker, and report submission (#709)**: The
  observer signs and submits `save_observations` from a Solana
  keypair (`SOLANA_KEYPAIR_PATH` / `OBSERVER_KEYPAIR_PATH`), uploads
  its report bundle to the permaweb under a separate upload identity
  — Arweave, Ethereum, or Solana, via `ARWEAVE_UPLOAD_KEY_FILE`,
  `ETHEREUM_UPLOAD_PRIVATE_KEY*`, or `SOLANA_UPLOAD_KEYPAIR_PATH` —
  and optionally runs the permissionless epoch cranker
  (`ENABLE_EPOCH_CRANKING`, default `false`).
- **HTTPSIG signing with the Solana observer key (#758)**: Response
  trust headers (RFC 9421) are signed directly with the observer's
  Solana keypair; verifiers derive the Solana address from the
  `keyId` and look it up in the on-chain GAR, so no separate
  attestation document is needed. The key can be supplied as a file
  (`OBSERVER_KEYPAIR_PATH`) or an inline base58 secret
  (`OBSERVER_PRIVATE_KEY`).

### Changed

- **`@ar.io/sdk` → stable `4.0.0` (#765)**: Moves off the
  `4.0.0-solana.*` prereleases (#761, #763) to the published stable
  release, which includes the compound crank-step
  transaction-size fix (`ar-io/ar-io-sdk#670`) that unwedges epoch
  progression on populated networks.
- **Mainnet program IDs by default (#766)**: `docker-compose.yaml`
  now defaults the four `ARIO_*_PROGRAM_ID` vars to the mainnet
  program IDs so a fresh mainnet deploy starts the observer without
  extra configuration — the observer requires them set and will not
  start otherwise. Operators on devnet/staging override via `.env`.
- **Default observer image → Solana 4.0.0 container (#767)**:
  `OBSERVER_IMAGE_TAG` now defaults to the Solana-track observer
  build.
- The gateway is now **Solana-only** for registry/ArNS/epoch
  reads; the AO compute-unit dependency for protocol state has been
  removed.

### Fixed

- **`attachStallTimeout` timer leak**: Unref the stall and
  wall-clock timers so a settled stream no longer keeps the event
  loop alive.
- **Over-eager source-cascade abort (PE-9108)**: Abort the data
  source cascade only on a genuine client disconnect, not on
  internal stream transitions, so legitimate retrievals are no
  longer cut short.
- **Empty/NULL `data_root` could serve unrelated content (#755)**:
  An L1 transaction with an empty or NULL `data_root` matched any
  `data_roots` row keyed on an empty value, returning an unrelated
  file's hash; the unguarded insert also planted such poison rows.
  Both queries are now guarded, the insert is a no-op for empty
  input, and a forward-only migration removes any previously
  planted rows.

## [Release 79] - 2026-05-27

This is a **recommended release** focused on **ANS-104 unbundling
hang prevention**, the **ClickHouse streaming pipeline for the
unstable head**, and **byte-range / partial-content hardening**.
Key highlights include four new wall-clock-cap and timeout layers
across the unbundling pipeline (#744, #746, #748, #754) that close
every observed AbortSignal-immune hang path — workers can no longer
wedge permanently inside `DataImporter.download`,
`Ans104Parser.parseBundle`'s `getData`, the stream-to-disk pipeline,
or the worker thread itself; a new opt-in **ClickHouse streaming
pipeline** (`CLICKHOUSE_STREAMING_ENABLED`, #699) backed by
`new_blocks` / `new_transactions` ClickHouse tables so GraphQL
queries against the unstable head no longer wait for the hourly
parquet round-trip; and a **Range / 200-acceptance hardening pass**
(PE-9098) that gives the gateway a useful fallback when upstreams
strip Range headers, bounds overstreaming via
`GATEWAYS_RANGE_ACCEPT_200_MAX_OFFSET`, and corrects byte-count
recording on the sliced path. Other notable additions: configurable
`DATA_ITEM_INDEXER_WORKER_COUNT` (#747) for indexer-bound workloads,
a **chain-anchored chunk metadata fast path with outbound hint
propagation** (#705), and a substantial new observability surface
for the data-importer phase counters, bundle download
timing/size, and bundle-repair-worker. Operationally significant
fixes: a `ReadThroughDataCache` source-stream tee that eliminates a
backpressure race wedging the ar-io-network backfill (#737), an
`ar-io-data-source` limiter-slot leak on stream 'end' (#735), an
HTTPS-SNI bug in `DnsResolver` breaking the chunks-offset-aware
path (#729), a content-type predicate that crashed on stored
`null` content-types (PE-9099), and GraphQL federation
sort-order / null-height regressions (PE-9092).

### Added

- **ClickHouse Streaming Pipeline for the Unstable Head (#699,
  #696)**: Opt-in pipeline that mirrors the SQLite `new_*` tables
  into ClickHouse so GraphQL queries against the unstable head can
  read from ClickHouse directly instead of waiting for the hourly
  parquet round-trip. Adds `new_blocks` and `new_transactions`
  tables (mirroring `transactions` shape, with inline `signature` /
  `owner` and a uniform `inserted_at`-anchored TTL replacing the
  stable table's offset/size/bloom/partition machinery). Reorgs
  trigger bounded `ALTER TABLE ... DELETE WHERE` on the `new_*`
  tables. Activated by `CLICKHOUSE_STREAMING_ENABLED` (default
  `false`); tunable via `CLICKHOUSE_STREAMER_BATCH_SIZE` (default
  500), `CLICKHOUSE_STREAMER_FLUSH_INTERVAL_MS` (default 1000),
  `CLICKHOUSE_STREAMER_QUEUE_MAX_SIZE`, and
  `CLICKHOUSE_NEW_TX_TTL_MINUTES` (default 240). GraphQL gains a
  third merge leg over `new_transactions`; the SQLite leg can be
  reduced to a tight-timeout fallback via
  `CLICKHOUSE_GQL_SKIP_SQLITE_READS` with the timeout governed by
  `CLICKHOUSE_SQLITE_FALLBACK_CIRCUIT_BREAKER_TIMEOUT_MS`. Also
  adds `HTTPSIG_BODY_DIGEST_BUFFER_MAX_BYTES` (default 2 MiB) — the
  upper bound for buffering small uncached bodies to emit a
  `Content-Digest` header; larger bodies stream without one. When
  `CLICKHOUSE_STREAMING_ENABLED=false` (the default), behavior is
  identical to the pre-streaming two-leg path.

- **ANS-104 Unbundling Hang Prevention (#744, #746, #748, #754)**:
  Four cooperating layers that close every observed AbortSignal-immune
  hang path. (1) `DATA_IMPORTER_DOWNLOAD_TIMEOUT_MS` (default 20 min,
  #744) caps `DataImporter.download` via `Promise.race` independent
  of AbortSignal — fixes wedges where 32 of 32 download workers
  pinned indefinitely on backpressured streams. (2)
  `ANS104_UNBUNDLE_GET_DATA_TIMEOUT_MS` (default 30 s) +
  `ANS104_UNBUNDLE_STREAM_TOTAL_TIMEOUT_MS` (default 2 min) (#746)
  bound the parser's data-fetch and stream-to-disk phases with
  AbortSignal-based timeouts; the offset source's reader is
  rewritten to consume via `getReader()` so stream errors and
  aborts reject the promise instead of hanging. (3)
  `ANS104_PARSE_JOB_TIMEOUT_MS` (default 10 min, #748) covers the
  remaining case where a worker thread stays alive but never posts
  a terminal message — fires `worker.terminate()` and the existing
  `'exit'` handler reaps and respawns. (4)
  `ANS104_UNBUNDLE_GET_DATA_WALL_CLOCK_TIMEOUT_MS` (default 5 min,
  #754) is the parseBundle-level mirror of #744's
  `Promise.race` cap, closing the ~0.4 % of cases where the
  cascade ignores the AbortSignal. New metrics:
  `ans104_parser_get_data_wall_clock_fires_total`,
  `ans104_parser_job_timeouts_total`,
  `data_importer_worker_phase_total{phase="timer_*"}`,
  `bundles_unbundle_started_total`, `bundles_unbundle_in_flight`,
  `ans104_parser_jobs_started_total`,
  `ans104_parser_worker_pool_size`,
  `ans104_parser_worker_exits_total`. Also adds `STREAM_REQUEST_TIMEOUT_MS`
  (default 15 min) — the underlying wall-clock cap on
  `attachStallTimeout` used by `ArIODataSource` and
  `GatewaysDataSource` to bound paused-stream wedges.

- **Chain-Anchored Chunk Metadata Fast Path (#705)**: Decodes the
  `X-Arweave-Chunk-*` headers that peer gateways emit on
  `/chunk/{offset}/data` into structured chunk metadata, then
  cross-checks every field against the chain — a header that
  disagrees throws `ChainAnchorMismatchError` and the caller falls
  back to the canonical chain lookup, so peer headers are *hints*,
  never silently trusted. When the hint passes anchoring, the
  gateway skips a chain round-trip per chunk and re-emits the same
  headers on its outbound response so downstream consumers can
  anchor in turn. Enabled by default
  (`CHUNK_METADATA_ANCHOR_ENABLED=true`), with
  `CHUNK_METADATA_ANCHOR_REQUEST_TIMEOUT_MS` (default 5000),
  `CHUNK_METADATA_ANCHOR_TX_CACHE_SIZE` (default 1024), and
  `CHUNK_METADATA_ANCHOR_TX_CACHE_TTL_SECONDS` (default 300) as
  tunables.

- **Accept 200 for Range Requests and Slice Locally (PE-9098)**:
  Some upstreams (most often nginx with `proxy_cache` but no
  `slice` module) silently strip the client's `Range` header and
  return a full 200 body. `GatewaysDataSource` previously rejected
  these with `Expected 206`, falling through to a worse source.
  The gateway now accepts the 200, slices locally, and bounds the
  wire-cost via `GATEWAYS_RANGE_ACCEPT_200_MAX_OFFSET` (default
  10 MiB) — when `region.offset` exceeds the cap, the 200 is
  rejected and the next source tier is tried. Guarded against
  `NaN` / negative env values.

- **Configurable `DATA_ITEM_INDEXER_WORKER_COUNT` (#747)**:
  `DataItemIndexer`'s fastq concurrency was hardcoded to 1.
  Operators draining a large failed-bundle backlog can now raise it
  (default 1, backward compatible) to pipeline main-thread JS work
  while the prior `saveDataItem` is in flight to the SQLite worker.
  Upper bound on speedup is bounded by SQLite single-writer
  semantics.

- **Caller-Supplied Content-Type Predicate with Lazy Poisoned-Cache
  Eviction (PE-9099)**: `ContiguousDataSource.getData()` accepts an
  optional `acceptContentType` predicate. When supplied,
  `GatewaysDataSource` rejects upstream responses whose
  `Content-Type` fails the predicate before any bytes are returned
  (the cascade falls through to the next priority tier), and
  `ReadThroughDataCache` lazily evicts cache entries whose stored
  content-type fails: the on-disk blob is deleted and the request
  treated as a cache miss, so the next fall-through fetch heals the
  entry. Closes the long-standing 1134-byte `text/html`
  bundlr-network parking-page poisoning from the Sept-2024 outage
  that the indexer's ANS-104 parser couldn't unbundle.

- **Data-Importer + Bundle-Repair Observability (#728, #736,
  2c51ee6f, 58090309)**:
  `bundle_download_duration_seconds{outcome}` and
  `bundle_download_size_bytes{outcome}` (#728) correlate slow
  downloads with payload size; `data_importer_queue_full_skips_total`
  (#728) makes previously-silent queue-full drops scrapeable.
  `data_importer_worker_phase_total{phase=started|got_data|stream_ended|...}`
  (#736) pinpoints where a wedged worker is stuck (gaps between
  phases are exactly worker-count when the pipeline locks up).
  Bundle-repair gains `bundles_unbundling_backlog` (true backlog
  including bundles awaiting their first unbundle, not just retries)
  alongside the existing `bundle_repair_pending_bundles`.
  `bundles_unbundle_skipped_total{reason="no_workers"|"high_queue_depth"|"queue_full"}`
  (58090309) accounts for each pre-pipeline skip path at
  `Ans104Unbundler.queueItem`.

- **ClickHouse Pipeline Observability (8f9b1151)**: Two new gauges
  make the parquet → ClickHouse staleness gap legible from Grafana.
  `min_stable_data_item_height` exposes `MIN(height)` over
  `stable_data_items` — flat across multiple auto-import cycles
  means the prune is no-op-ing (typically because a backfill keeps
  inserting rows at low heights with an `indexed_at` newer than the
  prune threshold). `clickhouse_max_imported_height` tracks how far
  the auto-import process has advanced — the gap against the SQLite
  stable height is the lag operators actually care about.

### Changed

- **`isAcceptableBundleContentType` Widened (PE-9099)**: The
  bundle content-type predicate now accepts `binary/octet-stream`
  (a legacy MIME synonym of `application/octet-stream` present on
  ~350 rows in production gateway caches) in addition to
  `application/octet-stream`, `application/x-arweave-data`, and
  absent / `null` content-types. Input is normalized with
  `trim()` + `toLowerCase()` so cosmetic upstream variants
  (`Application/Octet-Stream`, leading/trailing whitespace) no
  longer cause spurious cache fall-through. The rejected
  content-type metric label is also stripped of parameters
  (`; charset=…`) to bound Prometheus cardinality.

- **Bundle-Repair Routes Retries Directly to the Unbundler
  (PE-9098)**: `BundleRepairWorker.retryBundles()` previously
  routed every failed bundle through `TransactionFetcher.queueTxId`,
  which is structurally wrong for BDIs (chain nodes don't index
  BDIs) and event-driven for L1s (TX_INDEXED → unbundler
  subscription drops retries silently when the unbundler queue is
  full). Retries now queue directly to the unbundler, with bundles
  that match neither path retained for the next BRW cycle.

- **`selectFailedBundleIds` Skips Non-Bundle Transactions
  (PE-9101)**: The live and backfill queue paths gate on the
  `Bundle-Format` tag, but the admin `/ar-io/admin/queue-bundle`
  endpoint does not (`bypassFilter` defaults to `true`). Non-bundle
  transactions queued through admin landed in `bundles`, never set
  `matched_data_item_count`, and were retried by `BundleRepairWorker`
  forever — each retry failing in the ANS-104 parser with
  `Invalid buffer`. The retry query now excludes rows whose root
  transaction is provably non-bundle (indexed locally and lacking
  `Bundle-Format=binary`); unknown roots stay eligible.

### Fixed

- **`ReadThroughDataCache` Source-Stream Tee (#737)**: On a cache
  miss, `ReadThroughDataCache.getData()` returned the same inner
  source stream to two consumers — the disk-cache `pipeline()` and
  the caller (`DataImporter.download` or the HTTP handler). Pipeline
  managed pause/resume internally; the caller called `.resume()` once
  at startup. When the disk cache paused for a slow write, the source
  went to recv-window-zero on its TCP socket, the peer stopped
  sending, and the worker waited indefinitely for `'end'` /
  `'error'` events that never came. Manifested as bundle-backfill
  wedges 15–30 minutes into every run with
  `BACKGROUND_RETRIEVAL_ORDER=ar-io-network,…`. Fix introduces a
  `PassThrough` that the pipeline tees into so the source has a
  single consumer governed entirely by the disk-pipeline's outcome,
  not by pause/resume races on the underlying `IncomingMessage`.
  Also fixes a `cacheStream` leak when `dataStore.finalize()` throws.

- **`ar-io-data-source` Peer-Limiter Slot Release on Stream 'end'
  (#735)**: The `streamPeerCounts` / `peerRequestLimiter` release
  path listened only on `stream.once('close', …)`. For HTTP
  `IncomingMessage` streams consumed via `pipeline()` under a
  keepAlive `http.Agent`, `'close'` can fire late or not at all —
  the socket is returned to the agent pool without the response
  object being destroyed. Every "successful" download leaked one
  limiter slot. After 15–30 minutes every peer hit `maxConcurrent`,
  `executeHedgedRequest` could no longer dispatch, and 24 download
  workers blocked silently on sources that never returned data. Now
  listens on `'end'`, `'error'`, and `'close'`, whichever fires first.

- **`DnsResolver` SNI Preservation for HTTPS URLs (#729)**: When
  `PREFERRED_CHUNK_GET_NODE_URLS` included HTTPS endpoints (e.g.
  `https://arweave.net`), the DNS resolver overwrote the URL
  hostname with the resolved IP. `fetch()` then sent TLS SNI = IP
  and `Host: IP`, mismatching the server certificate and triggering
  `ERR_TLS_CERT_ALTNAME_INVALID`. Failures bubbled up through
  `ArIOChunkSource` as silent zero-success rates from otherwise
  healthy upstreams. HTTPS URLs now return unchanged from the
  resolver; only HTTP URLs go through DNS substitution.

- **`isAcceptableBundleContentType` Null Safety (PE-9099)**: Stored
  attributes from SQLite surface `NULL` as JS `null`, not
  `undefined`. The predicate's `undefined`-only guard missed it,
  and `.trim()` on `null` threw `TypeError: Cannot read
  properties of null (reading 'trim')` — every cache lookup where
  the stored content-type was `NULL` failed, the unbundle bounced
  back to the repair pool, and post-deploy throughput collapsed.
  Signature widened to `string | null | undefined` with an explicit
  null check.

- **GraphQL Federation Sort-Order + Null-Height Preference
  (PE-9092)**: Two interacting defects in the federation merge.
  (1) `mergeEdges` could emit edges out of sort order when a richer
  duplicate replaced an earlier emission — under `HEIGHT_DESC` the
  merger picked null-height edges first and a later resolved
  duplicate overwrote slot 0, yielding e.g. `[x(100), y(200)]`
  instead of `[y(200), x(100)]`. (2) Dedup in
  `getGqlTransaction` / `getGqlTransactions` could return a
  null-height (optimistic) record over a fully-resolved record for
  the same id when both were present in the peer set. Fix
  collects emissions into a `Map` keyed by `node.id`, prefers
  height-resolved over null-height, and always forwards the full
  block sub-selection upstream so partial selections produce
  consistent block field hydration.

- **Range Path Consumer-Byte Recording on Sliced 200 (PE-9098)**:
  When the 200-with-Range fallback kicks in, the stream is sliced
  to `region.size`, but the stream-bytes total and size histogram
  were recording the upstream `content-length`. Overcounted by up
  to the full body minus `region.size` (e.g. 140 MB instead of
  512 bytes for a signature fetch). Recorded counts are now the
  consumer-visible sliced size.

- **`ReadThroughDataCache` Caller Region Size Through BDI Parent
  Resolution (PE-9098)**: When a requested item resolved via its
  parent's cached blob, the recursive `getCacheData` call replaced
  the caller's `region.size` with the child's full `data_size`
  before handing the region to `FsDataStore`. For BDI-nested items
  that meant opening an `fs.createReadStream` window spanning
  hundreds of MB to multiple GB instead of the few hundred bytes
  the caller wanted. Caller's region is now preserved end-to-end.

- **Webhook Emitter Log Bloat (#727)**: The previous catch block
  passed the entire `AxiosError` object to winston, which
  serialized the underlying keep-alive agent's Timer linked list
  until the circular guard kicked in — producing 2–4 MB log lines
  per failed delivery. At ~30 failures/hour from a single 429
  webhook target, the 100 MB × 5 docker log rotation budget was
  consumed in ~10 minutes and other log lines were evicted.
  Extracts useful fields (status, code, message, truncated body,
  target URL) and logs a structured object; response bodies clamp
  to 500 chars.

- **`min_stable_data_item_height` Gauge Moved to Main Thread
  (0fa21dee)**: `computeDebugInfo()` runs in a SQLite worker
  thread, which has its own `prom-client` registry. The scrape
  endpoint reads the main-thread registry, so a gauge set inside
  the worker never reached it. Now set in
  `StandaloneSqliteDatabase.getDebugInfo()` after `queueRead`
  returns.

- **Streaming Backpressure in `ReadThroughDataCache` Cache-Miss
  Path (4c9d1d13)**: The cache-miss path piped into the disk-cache
  write stream via `pipeline()` and also attached a `.on('data')`
  hashing/byte-counting listener. Two consumers on the same
  readable forced flowing mode and short-circuited pipeline
  backpressure: `cacheStream`'s internal buffer grew beyond
  `highWaterMark` while waiting on disk writes, holding
  multi-MB per concurrent download. At 24+ download workers this
  produced external-memory pressure. Hashing moved into a
  `Transform` so backpressure is preserved end-to-end.

- **`selectFailedBundleIds` Index (855ba8c3)**: The retry-loop
  `SELECT` is now ~200× faster after correcting the index column.
  The pre-existing `import_attempt_last_retried_idx` had been on
  `import_attempt_count` since the Jan 2025 retry-stats refactor,
  but the query orders by `retry_attempt_count` — a different
  column. Replaced with `bundles_active_retry_priority_idx` on
  `(last_fully_indexed_at, retry_attempt_count, last_retried_at)`.
  Live measurement: 4.32 s → 20.5 ms per call.

- **Shared Keep-Alive HTTP Agents in `GatewaysDataSource`
  (f487dcaa)**: `axios.create()` was called per request without
  agent configuration, so every request opened a fresh TCP+TLS
  connection that closed after the response — sending sockets
  through ~60 s TIME_WAIT. Under high `ANS104_DOWNLOAD_WORKERS`,
  500+ closed sockets accumulated in `ss -s`. Per-gateway-URL
  agent cache with `keepAlive: true` eliminates the churn.

## [Release 78] - 2026-05-08

This is a **recommended release** focused on **request-cancellation
plumbing**, **memory-safety hardening across data fetch paths**, and
**indexer backpressure**. Key highlights include **end-to-end
`AbortSignal` threading through GraphQL resolvers, attribute fetchers,
chunk fetches, and the trusted-node request queue** so client
disconnects no longer leave zombie work pinned on shared queues; a
**byte-range / Range-request hardening pass (PE-9081)** that closes
multiple paths through which oversized or truncated upstream responses
silently pinned large `Buffer`s in the external memory pool; and
**indexer backpressure** via batched matched-item draining
(`BUNDLE_DATA_ITEM_DRAIN_BATCH`) and hard caps on the
`DataItemIndexer` / `Ans104DataIndexer` queues with drop-on-full
recovery via `bundle-repair-worker`. Other notable fixes: stale ArNS
resolution-failure caching that poisoned upstream nginx caches with
the "unregistered" placeholder (PE-9072), a `CompositeArNSResolver`
fast-fail fallback gap during AO/CU flaps (PE-9075), a bundles
root-atom consistency bug that crashed the SQLite worker on optimistic
indexing races (PE-9073), an envoy `/tx` prefix routing fix for txids
starting with `tx` (PE-9079), an export-parquet metric-cardinality
bloat fix (PE-9078), an `Ans104OffsetSource` stream-lifecycle leak
(PE-9077), and a runtime dependency declaration for
`@ardrive/turbo-sdk` (PE-9074). Adds a substantial set of new
observability metrics for GraphQL request volume + cancellations,
attribute-fetch source attribution, and Node.js process / event-loop
saturation.

### Added

- **`CACHE_APEX_MAX_AGE` Configuration**: New environment variable that
  bounds the `Cache-Control` `max-age` returned for `APEX_TX_ID` responses
  (default 3600s, 1 hour) and adds the `must-revalidate` directive.
  Operators can now rotate `APEX_TX_ID` without leaving upstream proxies
  serving the previous content for the data-layer cache lifetime
  (potentially up to `CACHE_STABLE_MAX_AGE` with `immutable`). See
  PE-9072.

- **GraphQL Request Cancellation + Source-Attribution Metrics
  (PE-9087)**: A single `AbortSignal` composed from the express request
  close event and a configurable server-side deadline is now threaded
  through every GraphQL resolver and downstream attribute fetcher.
  When a client disconnects (or the deadline elapses), in-flight
  attribute fetches and `arweaveClient` requests cancel immediately
  instead of running to completion against arweave.net while their
  results are discarded. New env var `GRAPHQL_RESOLVER_DEADLINE_MS`
  (default 12000ms; set to `0` to disable) caps server-side resolver
  runtime. New metrics: `graphql_requests_total` (denominator for
  cancellation-rate alerts), `graphql_resolver_cancellations_total`
  with `{reason="client_disconnect"|"deadline_exceeded"}`,
  `attribute_fetch_total` and `attribute_fetch_duration_seconds`
  with `{kind, subject, source, outcome}` labels for end-to-end
  source attribution of L1 attribute fetches. Also fixes a bug where
  `getTransactionAttributes` always returned `owner: null` for L1
  transactions even when the wallet was already cached, forcing every
  owner query to round-trip to arweave.net.

- **Indexer Backpressure: Queue Caps + Batched Matched-Item Drain
  (PE-9089 + PE-9086)**: The unbundler's matched-item firehose now
  buffers in-process and drains in `setImmediate` batches sized by
  `BUNDLE_DATA_ITEM_DRAIN_BATCH` (default 100), guaranteeing
  event-loop turns for SQLite worker replies and other I/O when
  large bundles produce thousands of cross-thread messages per
  second. Buffer depth is exposed as
  `queue_length{queue_name="matchedItemBuffer"}`. The
  `DataItemIndexer` and `Ans104DataIndexer` queues now enforce hard
  caps (`DATA_ITEM_INDEXER_QUEUE_SIZE` and
  `ANS104_DATA_INDEXER_QUEUE_SIZE`, both default 500000; set `0` to
  disable). Non-prioritized items pushed at the cap are dropped and
  counted in `data_items_dropped_total{queue_name}`; the
  `bundle-repair-worker` recovers the dropped items on its next
  cycle, so dropping is a backpressure release valve, not data loss.
  Backpressure and depth checks are now O(1) tracked counters
  instead of linked-list walks.

- **Node.js Process and Event-Loop Observability Metrics**: The
  default `prom-client` collectors are now enabled, exposing
  `process_resident_memory_bytes`, `nodejs_heap_size_*`,
  `nodejs_eventloop_lag_seconds`, `nodejs_gc_duration_seconds`, and
  `nodejs_active_handles_total`. Adds a new
  `nodejs_event_loop_utilization` gauge (0..1, sampled at scrape
  time) — the most reliable signal for detecting main-thread
  saturation, since lag percentiles can read near-zero while the
  loop is fully pegged. Adds a `bundle_data_item_count` histogram
  (buckets up to 5M items) so heap and queue spikes can be
  correlated with the bundle size that triggered them rather than
  with aggregate ingest throughput.

### Changed

- **Manifest Resolution Type Surfaced**: `ManifestResolution` now carries
  an optional `resolutionType` field (`'path' | 'index' | 'fallback'`)
  populated by `StreamingManifestPathResolver`. Used by the data handler
  to apply different `Cache-Control` policies per resolution type — see
  Fixed below. The field is optional so external implementations of
  `ManifestPathResolver` remain compatible.

### Fixed

- **Stale ArNS Resolution-Failure Caching (affects all gateways by
  default)**: `ARNS_NOT_FOUND_ARNS_NAME` defaults to `'unregistered_arns'`,
  so on every failed ArNS resolution the middleware sets `req.dataId` to
  the resolved placeholder and calls `dataHandler` without setting any
  `Cache-Control`. `setDataHeaders` then applied the data-layer ladder —
  most commonly `CACHE_UNSTABLE_TRUSTED_MAX_AGE` (default 12h, but some
  operators run 90d). Result: the "Make this domain space yours"
  placeholder cached upstream (nginx honors upstream `Cache-Control`)
  and downstream long after a name actually registered. Same bug class
  on the `ARNS_NOT_FOUND_TX_ID` and `APEX_TX_ID` branches, and on
  manifest fallback responses where the URL → data-id binding is
  mutable across manifest revisions.

  Fixes:
  - `ARNS_NOT_FOUND_TX_ID` and `ARNS_NOT_FOUND_ARNS_NAME` resolved-404
    responses now emit
    `public, max-age=${CACHE_NOT_FOUND_MAX_AGE}, must-revalidate`
    (default 60s).
  - Manifest **fallback** responses emit the same short `Cache-Control`,
    overriding any longer ANT TTL set by the ArNS middleware. Path- and
    index-resolved manifest responses still inherit the ANT TTL.
  - `APEX_TX_ID` responses are bounded by `CACHE_APEX_MAX_AGE` with
    `must-revalidate` (see Added).
  - `sendNotFound` 404 responses now emit `must-revalidate` instead of
    `immutable`. (PE-9072)

  **Operator one-time sweep:** entries already poisoned in nginx caches
  must be evicted manually — grep cache files for the placeholder's
  `X-AR-IO-Data-Id` (or for the resolved id of `unregistered_arns` on
  default-config gateways) and remove matches.

- **ArNS cached fallback on fast-fail (PE-9075)**:
  `CompositeArNSResolver` previously fell back to a cached resolution
  only when fresh resolution exceeded
  `ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS`. When fresh resolution
  returned `undefined` faster than the timeout (names cache miss,
  AO/CU dry-run error swallowed to undefined), the fallback didn't
  fire and the gateway dropped through to `ARNS_NOT_FOUND_ARNS_NAME`
  — serving the "unregistered" placeholder for names with valid
  cached resolutions during AO/CU flaps. Now falls back to the
  cached resolution whenever fresh has no resolved id, matching the
  comment-documented intent. New metric
  `arns_cached_resolution_fallback_on_empty_total` counts how often
  this fires.

- **Byte-Range and Range-Request Hardening (PE-9081)**: Closes a set
  of related defects across the byte-range fetch paths that allowed
  oversized or truncated upstream responses to silently pass through
  to consumers and pin large `Buffer`s in the external memory pool.
  All byte-range sources now enforce a symmetric contract: the
  upstream `content-length` must equal the requested region size, and
  responses that exceed the requested range are truncated by a
  bounded transform that destroys the underlying socket on close.
  `attribute-fetchers` rejects signature/owner attributes whose size
  is `0` or undefined, and `fetchDataFromParent` pre-allocates its
  result buffer and aborts on the first oversize chunk (closing an
  unbounded accumulator path). `contiguous-data-byte-range-source`
  and `http-byte-range-source` now pass `maxContentLength` to axios
  to bound client-side buffering, and `ar-io-data-source` /
  `gateways-data-source` apply matching `206`-when-`Range`,
  `content-length` guards, and per-region byte caps.

- **AbortSignal Threading Through Chunk Fetches and Trusted-Node
  Path (PE-9076)**: When a client request aborted, the cancellation
  signal had no path into `trustedNodeRequestQueue` or the
  bucket-wait loops, so abandoned client requests still issued HTTP
  calls to arweave.net whose responses had nowhere to go.
  `trustedNodeRequest` now checks `signal.throwIfAborted()` at
  entry, after the bucket wait, and between tokens, releasing queue
  capacity immediately on disconnect. A new `abortablePromiseRace`
  helper isolates caller signals from the shared
  `chunkPromiseCache`, so a cancelled caller bails out without
  cancelling the underlying fetch for other waiters.

- **ANS-104 Offsets Stream Lifecycle Repair (PE-9077)**: Parsing
  paths in `Ans104OffsetSource` consume only a bounded prefix of the
  stream returned by `getData` and previously dropped the reference
  without destroying the stream. Under axios `responseType: 'stream'`
  the unread tail stayed pinned in the `IncomingMessage` external
  buffer pool — invisible to V8 — until the underlying socket was
  destroyed by eventual GC or unrelated cleanup. The parsing paths
  in `parseDataItemHeader`, `extractDataItemMeta`, and
  `getDataItemOffset` now explicitly destroy the stream on both
  success and error.

- **Envoy `/tx` Path Routing Fix (PE-9079)**: A redundant `/tx`
  prefix route in `envoy.template.yaml` shadowed the more specific
  `/tx/` rule for transactions whose ids start with the literal
  string "tx". Those requests were being routed to the
  `trusted_arweave_nodes` cluster intended for header-prefixed
  paths instead of the gateway data path, producing incorrect
  cache headers and skipping peer diversity. The redundant route
  is removed.

- **Export-Parquet Job-Status Metric Cardinality
  Normalization (PE-9078)**: The
  `/ar-io/admin/export-parquet/status/:jobId` route was falling
  through to the admin catch-all in the `normalizePath` helper, so
  every `randomUUID`-generated `jobId` became a permanent label
  value on `http_request_duration_seconds`. Combined with
  clickhouse-auto-import's polling cadence, metric cardinality grew
  unbounded over time and inflated scrape latency on indexer
  deployments. The path is now explicitly normalized alongside the
  singleton bundle-status endpoint.

- **Bundles Root-Atom Consistency + Optimistic-Indexing Fix
  (PE-9073)**: Fixes two interacting defects that caused the
  indexer's SQLite worker to crash when the optimistic data-item
  admin endpoint (`/ar-io/admin/queue-data-item`) raced with
  ANS-104 unbundling. The `new_data_items` table enforces a "root
  atom" invariant on eleven bundling-metadata fields (`parent_id`,
  `root_transaction_id`, `root_parent_offset`, `data_offset`,
  `offset`, `size`, `signature_offset`, `signature_size`,
  `owner_offset`, `owner_size`, `signature_type`) — they must move
  together or remain entirely `NULL` together. The admin endpoint
  unconditionally nulled three of them on every re-POST, so
  repeated admin POSTs after an unbundle regressed back-filled
  values to `NULL` and the next flush failed `NOT NULL` checks.
  The admin path now uses a dedicated `insertOptimisticDataItem`
  (`INSERT` with the root atom hardcoded `NULL`) and the unbundler
  uses `upsertNewDataItem` (atomic root-atom `UPDATE` with a
  `COALESCE`-protected safety net). GraphQL signature/owner
  resolvers guard against incomplete root-atom rows and return
  `undefined` with a warning rather than throwing. The
  `/ar-io/admin/debug` SQLite snapshot is now cached for
  `GET_DEBUG_INFO_CACHE_TTL_MS` (default 5 min, set `0` to
  disable), since each call runs unfiltered `COUNT(*)` scans on
  the SQLite worker and frequent polling was monopolizing the
  debug worker.

- **`@ardrive/turbo-sdk` Moved to Runtime Dependencies (PE-9074)**:
  `@ardrive/turbo-sdk` is required at runtime by the HTTPSIG
  attestation upload path (`src/lib/httpsig-upload.ts`) but was
  declared in `devDependencies`. The production Dockerfile's
  `yarn install --production` pruned it, producing a silent
  `MODULE_NOT_FOUND` at upload time and a fallback to the L1
  upload path — which fails when the gateway wallet has no AR
  balance. Now declared as a runtime dependency.

## [Release 77] - 2026-04-24

This is a **recommended release** focused on **cross-gateway GraphQL
fan-out**, **ClickHouse query-path hardening**, and **composite query
resilience**. Key highlights include **`GatewaysGqlQueryable`**, a new
adapter that fans GraphQL queries out to configured upstream
ar-io-node gateways and merges the results — letting a node compose
its local index with broader upstream coverage — and a **parallelized
composite ClickHouse/SQLite GraphQL path** protected by a SQLite
circuit breaker that surfaces `PARTIAL_RESULT` warnings via
`extensions.warnings` instead of silent partials. ClickHouse gets
several query-path improvements: **dropping `FINAL` in favor of
`LIMIT 1 BY` dedupe** to re-enable projection planning, a new
**`owner_address` bloom with projection skipping on tag filters**, a
**`tag_names` / `tag_values` fix for `owner_projection`**, a
**configurable query timeout** (default 3s), and a
**`max_rows_to_read` guardrail** that fails noisy full-scans fast. It
also adds **per-job status tracking** to the Parquet export admin API
and bundles an **Observer update to `ddd3a9c`** with reference-gateway
chunk-header offset validation and continuous-observer reliability
hardening, alongside a set of **ClickHouse auto-import reliability
fixes**.

### Added

- **Fan-Out GraphQL Over Upstream Gateways (`GatewaysGqlQueryable`)**: A
  new `GqlQueryable` adapter fans GraphQL queries out to configured
  upstream ar-io-node gateways and merges the results, letting a node
  act as a thin fan-out proxy or compose its local index with upstream
  sources for broader coverage. Single-record queries use
  first-non-null resolution; connection queries k-way merge by the
  ar-io-node cursor tuple and dedupe by id. Per-endpoint circuit
  breakers isolate slow or failing upstreams. Configured via
  `GATEWAYS_GQL_URLS`; disabled by default.

- **Configurable ClickHouse GraphQL Query Timeout**: The ClickHouse GQL
  backend now applies a configurable timeout both server-side (as
  `max_execution_time`, so ClickHouse aborts runaway queries and frees
  resources) and client-side (as the HTTP `request_timeout`, with a 2s
  grace window so the server-side timeout error surfaces before the
  client aborts). Default 3s.

- **`max_rows_to_read` Guardrail on ClickHouse GraphQL Queries**: Every
  GraphQL query against the ClickHouse `transactions` table now appends
  `SETTINGS max_rows_to_read = N`. Queries that would scan more than the
  configured threshold throw `Code: 158: Limit for rows ... exceeded`
  instead of silently scanning the whole table — catches
  projection-shadowing bugs and planner regressions where a skip index
  is bypassed. Default 10M rows (~20% of current table size); tunable
  via `CLICKHOUSE_GQL_MAX_ROWS_TO_READ`.

- **Per-Job Status Tracking for Parquet Export API**:
  `POST /ar-io/admin/export-parquet` now returns a `jobId`, and the
  exporter keeps a bounded per-job history (32 entries) so concurrent
  callers can each poll their own record at
  `GET /ar-io/admin/export-parquet/status/:jobId`. The legacy singleton
  status endpoint is retained for back-compat and still reflects the
  most-recent update. `scripts/parquet-export` prefers the per-job
  endpoint when a `jobId` is returned and falls back to the
  singleton-with-drift-detection path for older gateways.

### Changed

- **Observer Update to `ddd3a9c`**: Bundles two upstream PRs on top of
  the previous `21098d2` pin.
  - **Reference-gateway chunk-header offset validation**: The observer
    now HEADs the reference gateway's `/chunk/{offset}/data` and anchors
    the advertised `x-arweave-chunk-*` headers (tx id, boundaries, data
    root) to the chain via `/tx/{id}/offset` and `/tx/{id}`, replacing
    the block-and-tx binary search as the default offset-validation
    path. Typical cost drops from ~20–30 node lookups per offset to one
    HEAD plus two O(1) lookups per unique tx, with a per-tx LRU cache
    for repeated offsets. Any header/chain mismatch or missing header
    falls back to the legacy chain search, so older gateways keep
    working. New metric `observer_chunk_metadata_anchor_total{result}`
    (hit / cache_hit / metadata_missing / mismatch / error / fallback)
    tracks the rollout. Gateways that return an HTTP error on the new
    probe are no longer blacklisted from the shared pool — only
    transport failures do.
  - **Continuous observer reliability hardening**: The per-gateway
    schedule map is replaced with a flat list of `ScheduledObservation`
    events so duplicates, restart catch-up, and overdue retries are
    deterministic (legacy state auto-migrates on load). An explicit
    submission deadline (`windowEnd + submissionBufferMs`) now bounds
    the epoch — once exceeded, the scheduler clears pending work,
    marks the epoch `expired`, and stops issuing observations instead
    of spinning on stale state. Finalization is gated on both the
    window being complete and the pending queue being empty, and only
    flips `reportSubmitted` on a successful submit so transient
    submit failures retry. Unsubmitted prior epochs are discarded on
    epoch transition rather than force-finalized into the wrong epoch.
  - **Report telemetry**: Reports now record each gateway's `release`
    field from `/ar-io/info`, a `yarn summarize` script prints
    pass/fail counts grouped by release, and offset rendering now
    shows `<failures>/<observed> (<pct>)` so the denominator reflects
    the sampled subset.

- **ClickHouse GraphQL query no longer uses `FINAL`**: The composite
  ClickHouse backend previously issued `FROM transactions AS t FINAL` to
  deduplicate unmerged `ReplacingMergeTree` versions at read time. `FINAL`
  prevented `owner_projection` from being selected and forced a
  `PrimaryKeyExpand` that widened the skip-index-pruned granule set by
  ~4×. It is replaced with a `LIMIT 1 BY height, block_transaction_index,
  is_data_item, id` clause that dedupes in-engine as a post-sort filter
  without disabling projection planning or PREWHERE push-down. Safe
  because Arweave transaction data is immutable: all versions of a given
  primary key are byte-identical by construction.

- **Composite ClickHouse GraphQL Parallelized With SQLite Circuit
  Breaker**: The `CompositeClickHouseDatabase` now runs its ClickHouse
  and SQLite legs concurrently instead of serially, and wraps the
  SQLite leg in an opossum circuit breaker. ClickHouse errors
  (timeout, `max_rows_to_read`) still propagate to the caller, while
  SQLite failures degrade the response to ClickHouse-only results with
  a `PARTIAL_RESULT` warning attached via GraphQL `extensions.warnings`
  — ending silent partials for tip-of-chain rows and for the
  single-record `transaction(id)` lookup, which previously returned a
  bare `null` when SQLite was unavailable. The ClickHouse max-height
  boundary-optimization cache is now read non-blocking from the request
  path, with a background refresh keeping it warm. Fan-out preserves
  warnings end-to-end: `RemoteGqlQueryable` pulls upstream
  `extensions.warnings` off each response, `GatewaysGqlQueryable`
  merges them across sources, and synthesizes `UPSTREAM_UNAVAILABLE` /
  `UPSTREAM_CIRCUIT_OPEN` warnings for partially-failed aggregates that
  were previously logged-and-dropped. New env vars under
  `CLICKHOUSE_SQLITE_CIRCUIT_BREAKER_*` (defaults: timeout 5000ms,
  error threshold 80%, reset timeout 60000ms, rolling window 30000ms).

- **ClickHouse `owner_address` Bloom + Skip Projection on Tag Filters**:
  ClickHouse projections cannot carry inline skip indexes, so
  owner+tag GraphQL queries that routed through `owner_projection`
  scanned every granule within the owner range. An `owner_address`
  bloom filter is now defined on the main `transactions` table, and
  the per-query `optimize_use_projections = 0` guard is extended to
  tag filters. Owner-only queries still benefit from
  `owner_projection`'s sort order; owner+tag queries now fall back to
  the main table where `id_bloom` / `tag_names_bloom` /
  `tag_values_bloom` / `owner_address_bloom` can prune granules across
  all three dimensions. Existing deployments get the index registered
  via an idempotent `ALTER TABLE ... ADD INDEX IF NOT EXISTS` on the
  next `clickhouse-import` cycle; a manual
  `MATERIALIZE INDEX owner_address_bloom` is required to populate the
  index on existing parts.

- **Parquet Export Defaults to Include L1 Transactions and Tags**:
  `ParquetExporter.export()` defaults now align with the
  `scripts/parquet-export` CLI wrapper and the auto-verify harness,
  both of which already included L1 by default. Callers that want
  L2-only output must now pass `skipL1Transactions` /
  `skipL1Tags` explicitly.

### Fixed

- **ClickHouse `owner_projection` now usable for tag-filtered owner queries**:
  The projection was previously defined with `SELECT *`, which in ClickHouse
  excludes `MATERIALIZED` columns — so `tag_names` and `tag_values` were
  absent from the projection and the optimizer rejected it for any query
  with predicates on those columns (which includes all tag-filtered GraphQL
  queries). The projection body is now `SELECT *, tag_names, tag_values`, so
  the optimizer picks `owner_projection` for owner-scoped queries and reads
  orders of magnitude fewer granules. Existing deployments need a one-time
  manual migration (`DROP PROJECTION` / `ADD PROJECTION` / `MATERIALIZE
  PROJECTION`) — see the inline comment in
  `src/database/clickhouse/schema.sql`. Fresh deployments get the corrected
  projection from the `CREATE TABLE` body with no operator action required.

- **GraphQL `Block.timestamp` Non-Nullable Field Error**: Addresses a
  "Cannot return null for non-nullable field Block.timestamp" error
  that could surface when resolving blocks with incomplete data.

- **GraphQL Data Item Signature Fetch Falls Back to `NOT_FOUND`**: The
  data-item path in `resolveTxSignature` returned the fetcher result
  directly, so an `undefined` from
  `SignatureFetcher.getDataItemSignature` (e.g., missing attributes or
  a stream failure reading from the parent bundle) would trigger a
  "Cannot return null for non-nullable field" error on the `String!`
  signature field. The data-item path now mirrors the transaction
  path and falls back to `NOT_FOUND`.

- **`clickhouse-auto-import` Honors `SQLITE_DATA_PATH`**: The
  `clickhouse-auto-import` container had its SQLite bind mount
  hardcoded to `./data/sqlite`, while `core` used
  `${SQLITE_DATA_PATH:-./data/sqlite}`. When `SQLITE_DATA_PATH` was
  set, the two containers diverged: the daemon's `batch_has_data`
  pre-check resolved to a missing path and silently failed open, so
  empty height ranges were still sent through the full export/import
  pipeline. The mount is now consistent with core.

- **Fail-Fast on ClickHouse GraphQL Rejection**: Awaiting
  `Promise.allSettled` gated ClickHouse errors on the SQLite leg's
  breaker timeout. The composite flow now awaits ClickHouse first and
  rethrows immediately, absorbing SQLite rejections eagerly so bailing
  out early does not emit an unhandled rejection.

- **Reject Concurrent Parquet Exports + Skip Empty ETL Ranges**: The
  auto-import loop previously wasted cycles (and logged spurious
  "Input directory does not exist" / "Parquet file too short" errors)
  on batches that either collided with a still-running export or
  spanned empty height ranges. The admin endpoint now returns `409`
  instead of swallowing the rejection, the exporter script surfaces a
  clear error when the singleton status is stale, and batches with no
  source rows short-circuit via a `sqlite3` pre-check.

- **Hive-Layout ClickHouse Importer Requires `blocks` and
  `transactions` Files**: The Hive-layout importer iterated a
  per-table glob; when no files matched, bash left the literal pattern
  string in the loop variable and the `-f` check silently
  short-circuited, so the partition reported success even though zero
  required files were imported — combined with export races that
  produced empty staging dirs, this was silently dropping data. The
  `matched_count` validation from the flat-dir path is now ported so
  `blocks` and `transactions` each must contribute at least one file;
  `tags` may still be empty.

- **GraphQL Boundary Skips `minHeight` on SQLite "New" Tables**: The
  ClickHouse/SQLite GraphQL boundary raises `minHeight` to route
  historical queries away from SQLite. Applied to `new_transactions` /
  `new_data_items`, the resulting `height >= :minHeight` silently
  dropped pending rows whose height is `NULL`. Because the "new"
  tables only hold unstable/recent data that ClickHouse never covers,
  the predicate is now skipped entirely for those sources.

## [Release 76] - 2026-04-17

This is a **recommended release** focused on **response signing**,
**ClickHouse data lifecycle management**, and **query-path efficiency**. Key
highlights include **RFC 9421 HTTP Message Signatures** for cryptographically
verifiable gateway responses, **tag-based TTL rules for ClickHouse-exported
data** so operators can expire indexed rows by tag or uploader, and a major
**ClickHouse schema consolidation** into a single partitioned `transactions`
table with bloom filter skip indexes and native projections. It also adds
**per-host `APEX_ARNS_NAME` mapping**, **Parquet export partition progress**
in the status API, and a **`clickhouse-import --flat-dir` mode**. GraphQL
gets two performance improvements — **skipping SQLite for heights already
covered by ClickHouse** and **skipping the `owner.key` fetch when only
`owner.address` is selected** — plus a fix for duplicate transaction results
from ClickHouse and correctly-populated `indexedAt` / `blockPreviousBlock`
fields.

### Added

- **RFC 9421 HTTP Message Signatures for Gateway Responses**: The gateway
  can now sign responses using RFC 9421 HTTP Message Signatures, allowing
  clients to cryptographically verify response integrity and origin.
  Controlled by `HTTPSIG_ENABLED` (default: false) with an Ed25519 key
  auto-generated at `HTTPSIG_KEY_FILE` (default:
  `data/keys/httpsig.pem`). `HTTPSIG_BIND_REQUEST` (default: true) binds
  each response to the triggering request via `@method;req` and
  `@path;req`. An attestation linking the key to the operator wallet is
  uploaded to Arweave on startup when `HTTPSIG_UPLOAD_ATTESTATION=true`
  and `OBSERVER_WALLET` is set. HTTPSIG response metadata is documented
  in OpenAPI for `/ar-io/info` and data endpoints.

- **Tag-Based TTL Rules for ClickHouse-Exported Data**: Operators can now
  expire rows in the ClickHouse `transactions` table by tag content or
  uploader owner address. Rules are declared in
  `config/clickhouse-ttl-rules.yaml` (copy from the committed
  `.example.yaml` template) and loaded at the top of every
  `clickhouse-auto-import` cycle into four source tables, with exact-match
  lookups going through refreshing `COMPLEX_KEY_HASHED` dictionaries and
  prefix matches falling back to scanned tables. Native TTL enforcement
  deletes rows when `expires_at` elapses. Supports a top-level
  `default_ttl_seconds` fallback and per-rule `never_expire: true`
  exemptions (precedence: exempt > shortest TTL match > default > NULL).
  v1 applies only to rows imported after rules are loaded; no backfill.
  The loader fails open on missing/malformed rules to avoid blocking
  imports.

- **Per-Host `APEX_ARNS_NAME` Mapping**: `APEX_ARNS_NAME` now accepts a
  comma-separated list of values positionally mapped to `ARNS_ROOT_HOST`
  entries (e.g., `APEX_ARNS_NAME=turbo,ar-io` with
  `ARNS_ROOT_HOST=arweave.dev,g8way.io`). A single value still applies to
  all hosts.

- **Parquet Export Partition Progress in Status API**: The admin status
  endpoint and the `parquet-export` CLI poll loop now surface the
  current partition range and completed/total partition counts while a
  Parquet export is in progress.

- **`clickhouse-import --flat-dir` mode**: `scripts/clickhouse-import`
  accepts a flat directory of Parquet files named
  `<table>-minHeight:<min>-maxHeight:<max>-rowCount:<n>.parquet`
  (blocks / transactions / tags all in the same directory), as an
  alternative to the default `<table>/data/height=<min>-<max>/*.parquet`
  Hive layout.

### Changed

- **ClickHouse schema consolidation**: The ClickHouse GQL backend now uses
  a single `transactions` table with partitioning by height, bloom filter
  skip indexes on `id` and `tags`, and native projections for owner and
  recipient queries, replacing the previous four-table design
  (`transactions`, `id_transactions`, `owner_transactions`,
  `target_transactions`). Column codecs (Delta + ZSTD) and
  `LowCardinality` on `content_type` / `signature_type` reduce storage.
  The GQL query layer uses `hasAny` for multi-value tag filters and
  tuple-comparison cursor pagination. Requires ClickHouse 24.8 or later
  and a one-time full re-import from Parquet — see
  `docs/parquet-and-clickhouse-usage.md`.

- **Skip SQLite for Heights Covered by ClickHouse in GraphQL**: Opt-in
  optimization in `CompositeClickHouseDatabase` raises the SQLite
  fallback's `minHeight` to `(clickhouseMax - buffer + 1)` and skips the
  SQLite call entirely when the adjusted range is empty. Controlled by
  `CLICKHOUSE_SQLITE_MIN_HEIGHT_ENABLED` (default: false), with a
  configurable safety buffer (default: 10 heights) and a cached
  ClickHouse max-height lookup (default TTL: 60s). Degrades to prior
  behavior on lookup failure.

- **GraphQL `owner.key` Fetch Skipped When Only `owner.address` Requested**:
  Splitting the `Transaction.owner` resolver into field-level
  `Owner.address` and `Owner.key` resolvers lets GraphQL skip the per-row
  owner key fetch unless `key` is explicitly selected. Memoization on the
  `Owner` parent still fetches the key only once when multiple aliased
  selections or overlapping fragments request it in the same query.

- **Default ClickHouse Image Bumped to 26.3**: The default ClickHouse
  container image used by `clickhouse-auto-import` is now 26.3.

- **Observer Image Updated**: `OBSERVER_IMAGE_TAG` bumped to include
  epoch source fixes.

### Fixed

- **ClickHouse GQL `indexedAt` and `blockPreviousBlock` fields**: These
  fields were previously always returned as `undefined` because the base
  SELECT omitted the corresponding columns. They are now populated.

- **Duplicate GraphQL Transaction Results from ClickHouse**: The
  `transactions` table uses `ReplacingMergeTree(inserted_at)`, which only
  deduplicates during background merges. Queries now use `FINAL` so
  GraphQL returns a single edge per id instead of every un-merged
  version.

- **Tag Headers on Manifest-Resolved Responses**: When a manifest path
  resolves to an inner data item, `X-Arweave-Tag-*` headers are now
  populated from the resolved inner item rather than the manifest
  transaction.

- **Turbo Fallback Narrowed to Module-Not-Found**: The optional Turbo
  upload path now falls back only on module-not-found (instead of
  swallowing unrelated errors) and requires an explicit trigger header
  before signing.

## [Release 75] - 2026-04-08

This is a **recommended release** focused on **on-demand data item resolution**
and **response header enrichment**. Key highlights include **tag and verification
response headers** that expose transaction tags and cryptographic metadata
directly in HTTP responses, **on-demand data item metadata resolution** that
resolves unindexed data items by parsing ANS-104 bundle binaries on the fly,
**HyperBEAM as a root TX offset source** for efficient bundle navigation without
full downloads, and **GraphQL on-demand transaction resolution** for querying
unindexed data items. It also adds **configurable chunk GET retry behavior** to
reduce worst-case retrieval times and **Prometheus metrics for root TX semaphore
observability**.

### Added

- **Tag and Verification Response Headers**: Data responses on `/raw/:id` and
  `/:id` now include `X-Arweave-Tag-*` headers with transaction/data item tags,
  plus verification headers (`X-Arweave-Signature`, `X-Arweave-Owner`,
  `X-Arweave-Owner-Address`, `X-Arweave-Target`, `X-Arweave-Anchor`,
  `X-Arweave-Signature-Type`). Enabled by default
  (`ARWEAVE_TAG_RESPONSE_HEADERS_ENABLED=true`). Uses a fast local-only
  resolution path (LMDB txStore -> LRU cache -> GQL DB) with background indexing
  for uncached items. Includes a configurable byte budget
  (`ARWEAVE_TAG_RESPONSE_HEADERS_MAX_BYTES`, default 8KB) and tag count cap
  (`ARWEAVE_TAG_RESPONSE_HEADERS_MAX`, default 100). For L2 data item signatures
  and owner keys, `WRITE_ANS104_DATA_ITEM_DB_SIGNATURES=true` is also required.

- **On-Demand Data Item Metadata Resolution**: Data items not yet indexed locally
  are resolved on-demand by discovering the root bundle, parsing the binary
  header, and extracting signature/owner/tags. Results are cached in an LRU cache
  and persisted to the database for future requests. Background resolution is
  capped at 1 concurrent operation (configurable via
  `TX_METADATA_RESOLVE_CONCURRENCY`) with fail-fast semantics.

- **HyperBEAM Root TX Offset Source**: HyperBEAM can now be used as a
  root transaction offset source for on-demand data item resolution. Uses
  offset-guided recursive bundle index navigation to extract complete data item
  metadata without downloading full bundles. Controlled by
  `HYPERBEAM_ROOT_TX_ENABLED` and `HYPERBEAM_ENDPOINT` (default:
  `arweave.net`).

- **Configurable Chunk GET Retry Behavior**: Arweave chunk retrieval
  retry count and geometry timeout are now configurable, reducing worst-case
  chunk retrieval time from ~115s to ~15s. New env vars:
  `ARWEAVE_CHUNK_RETRY_COUNT` (default: 5), `ARWEAVE_TX_GEOMETRY_TIMEOUT_MS`
  (default: 5000), `ARWEAVE_TX_GEOMETRY_TIMEOUT_RETRIES` (default: 2).

- **GraphQL On-Demand Transaction Resolution**: The `transaction(id)` GraphQL
  query can now resolve unindexed data items on-demand by extracting metadata
  from ANS-104 bundle binaries. Enabled by default
  (`GRAPHQL_ON_DEMAND_RESOLUTION_ENABLED=true`). Includes a
  configurable timeout (`GRAPHQL_ON_DEMAND_RESOLUTION_TIMEOUT_MS`, default 5s)
  and concurrency limit (`GRAPHQL_ON_DEMAND_RESOLUTION_MAX_CONCURRENT`, default
  1). Only applies to single-ID lookups; the plural `transactions(...)` query is
  unaffected.

- **SignatureType in GraphQL**: The `signatureType` field is now surfaced in
  GraphQL transaction responses for data items.

- **Root TX Semaphore Prometheus Metrics**: New Prometheus metrics for root TX
  resolution semaphore observability, including acquire/release/timeout counters
  and queue depth gauge.

### Changed

- **Root TX Lookup Order**: `ROOT_TX_LOOKUP_ORDER` reordered to prefer GraphQL
  over HyperBEAM and CDB for faster local resolution.

- **HyperBEAM Request Timeout**: Default HyperBEAM request timeout lowered to
  500ms.

## [Release 74] - 2026-04-01

This is a **recommended release** focused on **cache performance**,
**multi-domain ArNS support**, and **content moderation correctness**. Key
highlights include **background caching for range request cache misses** to
improve video/media streaming performance, **multiple ArNS root hosts** for
serving ArNS names across multiple domains from a single gateway, **contiguous
data cache hit/miss Prometheus metrics** for improved observability, and
**configurable cache control for blocked responses**. It also corrects HTTP 451
handling for blocked content, simplifies the parquet export pipeline, and adds
ClickHouse and block verification to auto-verify.

### Added

- **Background Caching for Range Request Cache Misses**: When a range request
  (e.g., byte-range for video seeking) misses the local cache, the gateway now
  optionally fetches and caches the full item in the background so subsequent
  requests (range or full) are served locally. Controlled by
  `BACKGROUND_CACHE_RANGE_MAX_SIZE` (default: 0 / disabled) and
  `BACKGROUND_CACHE_RANGE_CONCURRENCY`. Includes deduplication, capacity-based
  drop semantics, and Prometheus metrics for monitoring cache activity

- **Multiple ArNS Root Hosts**: Operators can now serve ArNS names across
  multiple domains from a single gateway instance by providing a comma-separated
  list in `ARNS_ROOT_HOST` (e.g., `ARNS_ROOT_HOST=arweave.dev,g8way.io`). The
  first host is used as the "primary" for gateway identity headers. ArNS
  resolution, apex content, and sandbox redirects work per-matched host with
  longest-suffix matching (#621)

- **ClickHouse Verification in Auto-Verify**: Auto-verify is a data validation
  tool that checks consistency of indexed blockchain data (blocks, transactions,
  data items) across multiple backends (SQLite, Parquet, ClickHouse). This adds
  an optional ClickHouse source for verification in addition to the existing
  SQLite and Parquet sources.

- **Block Verification in Auto-Verify**: Verify block data alongside
  transactions and data items

- **Bundle Data Prefetch in Auto-Verify**: During auto-verify runs, raw bundle
  bytes are now fetched from the local gateway while it is still running, then
  parsed after shutdown. Previously the bundle-parser source had to fetch from
  arweave.net after the gateway was stopped, which was significantly slower.

- **Contiguous Data Cache Hit/Miss Metrics**: New
  `contiguous_data_cache_hits_total` and `contiguous_data_cache_misses_total`
  Prometheus counters in `ReadThroughDataCache`, labeled by `request_type`
  (`range` vs `full`). Enables operators to monitor cache performance per
  request type.

- **Accurate Cache Miss vs Not-Found Metrics**: Cache miss counter now fires
  only after a successful upstream fetch (data exists but wasn't cached locally).
  A new `contiguous_data_not_found_total` counter tracks requests where data is
  unavailable in any source, preventing not-found requests from inflating the
  miss count and skewing the cache hit rate.

- **Configurable Cache Control for Blocked (451) Responses**: New
  `CACHE_BLOCKED_MAX_AGE` env var (default: 30 days, matching stable data TTL)
  controls the `Cache-Control` max-age sent with 451 responses. Previously,
  blocked responses used the short not-found TTL, causing CDNs and proxies to
  re-request blocked content too frequently.

- **Parent Bundle ID in Missing Data Item Errors**: Auto-verify `compareItems`
  now includes the parent bundle ID in `missing_in_source` discrepancy messages
  for data items, making it easier to identify which bundle a missing item
  belongs to when debugging bundle-parser failures.

### Changed

- **Parquet Export Pipeline Simplification**: Eliminated DuckDB intermediate
  tables from the export pipeline. All core export logic moved from the bash
  script into `src/workers/parquet-exporter.ts`, with the CLI script becoming a
  thin wrapper around the admin API. The CLI now uses `--api-host`/`--api-port`
  instead of `--core-db`/`--bundles-db`.

- **Removed Legacy Auto-Verify CLI Options**: Cleaned up deprecated verification
  flags

### Fixed

- **ClickHouse ETL Height Range**: Fixed off-by-one errors in height range
  calculations in `clickhouse-auto-import`

- **ClickHouse ETL Exit Code Capture**: Fixed `$?` capturing the exit code of a
  variable assignment instead of the `curl` command

- **HTTP 451 for Blocked Content**: Corrects r73's blocked-content status code
  from 452 (non-standard) to 451 ("Unavailable For Legal Reasons"), the
  IANA-registered standard for content blocked due to legal or policy reasons.

- **Trusted Gateway ArNS 451 Handling**: The `TrustedGatewayArNSResolver` now
  accepts HTTP 451 responses from trusted gateways instead of treating them as
  errors. When a trusted gateway indicates a name is blocked, the local gateway
  respects that moderation signal and returns 451 to the client rather than
  falling through to the on-demand resolver.

- **Serving Cached Data with Undefined or Zero Content-Length**: The read path
  of `ReadThroughDataCache` now skips cache entries with a missing or zero
  `dataSize`, preventing responses without a `Content-Length` header. The write
  path already rejected zero-size entries; this closes the corresponding
  read-side gap.

- **Parquet Export and ClickHouse Import Robustness**: Parquet-export script now
  uses `curl -o` with temp files instead of `head`/`tail` parsing to handle
  multiline JSON API responses correctly. Auto-verify's `importToClickHouse`
  switches to `execFileSync` with an args array, preventing shell injection in
  ClickHouse import invocations.

- **Parquet Export Verify-Count Non-Zero Exit**: `parquet-export --verify-count`
  now exits non-zero when row counts don't match, making it useful in CI and
  automation pipelines. Also validates `curl` availability at startup alongside
  `python3`.

- **High-Severity Dependency Vulnerabilities**: Resolved known vulnerabilities in
  transitive production dependencies via yarn resolutions: `path-to-regexp`
  (ReDoS, via express/express-openapi-validator), `h3` (request smuggling),
  `picomatch` (glob injection), `preact` (VNode injection), `socket.io-parser`
  (unbounded binary attachments), `undici` (multiple HTTP smuggling/memory
  issues), and bumped `fast-xml-parser` from 5.3.6 to 5.5.9.

- **JSON Data Files Missing from Production Build**: `offset-block-mapping.json`
  was excluded from `dist/` because the build copy step only matched `.graphql`,
  `.sql`, and `.lua` files. This caused a startup warning and fallback to slower
  full-range block searches in containers. `.json` files are now included in the
  copy step.

- **Auto-Verify Prefetch Timing and Empty ClickHouse URL**: Removed the
  `last_fully_indexed_at` filter from the bundle prefetch query — this flag is
  set asynchronously by `BundleRepairWorker`, causing prefetch to find 0 bundles
  even when indexing was complete. Also handles `AUTO_VERIFY_CLICKHOUSE_URL=""`
  (empty string) explicitly to prevent a crash when the variable is set but
  empty in `.env`.

## [Release 73] - 2026-03-18

This is a **recommended release** focused on **operator configurability** and **P2P retrieval performance**. Key highlights include **unified Cache-Control headers** with operator-configurable durations, **hedged peer requests with consistent hash routing** to reduce tail latency and improve cache efficiency, **request trace IDs** for end-to-end correlation, and a **cache-only mode** for protecting upstream bandwidth from high-volume clients. It also fixes HTTP 452 responses for blocked content, corrects client disconnect detection, and addresses security audit vulnerabilities.

### Added

- **Unified Cache-Control Headers**: Move default Cache-Control from Envoy's
  catch-all route into Express middleware, eliminating duplicate headers and
  making data handler cache durations operator-configurable via
  `DEFAULT_CACHE_CONTROL_MAX_AGE_SECONDS`, `STABLE_CACHE_CONTROL_MAX_AGE_DAYS`,
  and related env vars

- **Cache-Only Client IPs/CIDRs**: New `CACHE_ONLY_CLIENT_IPS_AND_CIDRS` env
  var to short-circuit data retrieval requests with a 404 if the data is not
  already cached locally, useful for protecting upstream bandwidth from specific
  high-volume clients

- **Client Disconnect Prometheus Metric**: New `client_disconnect_total` counter
  metric tracks when clients abort requests before the response completes

- **P2P Contiguous Data Retrieval Improvements**: Major overhaul of peer data
  retrieval to reduce tail latency and improve cache efficiency
  - **Hedged requests**: Fires a second request to the next candidate peer after
    a configurable delay (`PEER_HEDGE_DELAY_MS`) if no response yet; first
    success cancels all others, capped at `PEER_MAX_HEDGED_REQUESTS`
  - **Per-peer concurrency limiter**: Fail-fast counter that skips saturated
    peers instead of queuing, configurable via `PEER_MAX_CONCURRENT_OUTBOUND`
  - **Consistent hash ring**: Routes each data ID to the same small set of
    "home" peers for cache locality, with weighted fallback for remaining slots;
    configured via `PEER_HASH_RING_VIRTUAL_NODES` and
    `PEER_HASH_RING_HOME_SET_SIZE`
  - **Decoupled candidate pool**: `PEER_CANDIDATE_COUNT` replaces the old
    `min(peerCount, 3)` logic, giving hedging a deeper bench to draw from
  - **Chunk peer selection via hash ring**: Chunk requests are also routed
    through the hash ring by absolute offset for improved peer cache utilization

- **Request Trace IDs**: Every HTTP request gets a unique `requestId` in Winston
  log entries via AsyncLocalStorage, independent of OTEL. Reads or generates
  `X-Request-Id` headers and echoes them in responses for end-to-end request
  correlation

### Changed

- **HTTP 452 for Blocked Content**: Blocked content now returns HTTP 452 with a
  descriptive message identifying the blocked ID and the node's content policy,
  instead of a generic 404 Not Found

### Fixed

- **HTTP 499 Only for Actual Client Disconnects**: Internal data retrieval
  timeouts (e.g., upstream gateway timeouts) were being misidentified as client
  disconnects. Now checks `req.signal.aborted` to confirm the client actually
  disconnected before returning 499

- **`/tx_anchor` Route Shadowing**: Move `/tx_anchor` route before `/tx` in
  Envoy config to prevent prefix-match shadowing that caused `/tx_anchor`
  requests to be handled by the `/tx` route

- **Security Audit Vulnerabilities**: Bump `simple-git` to fix critical RCE via
  `blockUnsafeOperationsPlugin` bypass; add `multer` resolution to fix high
  severity DoS vulnerabilities in `express-openapi-validator`

## [Release 72] - 2026-03-11

This is a **recommended release** focused on **data retrieval reliability** and **caching intelligence**. Key highlights include a **negative data cache** that reduces upstream load for consistently missing data, **direct byte offset hints** to help gateways locate data when internal lookup mechanisms fall short, **untrusted data caching with stochastic re-verification**, and significant **stream reliability improvements** that eliminate false timeouts on large transfers. It also adds **gateway loop prevention** via per-gateway via-chain detection.

### Added

- **Negative Data Cache**: Two-phase cache that tracks data IDs consistently
  missing across configurable thresholds and short-circuits future requests with
  404 responses, reducing upstream load during outages and for permanently
  unavailable data
  - Includes exponential backoff with fast re-promotion, health gating to
    prevent false positives during upstream outages, and TTL-based miss tracker
    eviction
  - Controlled via `NEGATIVE_CACHE_ENABLED` (default: true),
    `NEGATIVE_CACHE_MAX_SIZE`, `NEGATIVE_CACHE_TTL_MS`,
    `NEGATIVE_CACHE_MISS_THRESHOLD_MS`, and
    `NEGATIVE_CACHE_MISS_COUNT_THRESHOLD`

- **Direct Byte Offset Hints for Data Item Retrieval**: Clients can supply
  `X-AR-IO-Root-Transaction-Id`, `X-AR-IO-Root-Path`,
  `X-AR-IO-Root-Data-Offset`, and `X-AR-IO-Root-Data-Size` headers to bypass
  server-side bundle lookups and resolve data items via direct byte offsets
  - Includes `fetch-with-hint` CLI tool for resolving hints via GraphQL

- **DATA_CACHED Webhook Event**: Emits a webhook when data is cached for the
  first time, enabling external content moderation sidecars (e.g., phishing
  scanners)
  - Opt-in via `WEBHOOK_EMIT_DATA_CACHED_EVENTS=true` (default: false)

- **Untrusted Data Caching with Stochastic Re-verification**: Caches all
  upstream data optimistically instead of only when a hash exists locally, with
  configurable background re-verification rates to ensure integrity
  - Controlled via `UNTRUSTED_CACHE_RETRY_RATE` (default: 0.1) and
    `TRUSTED_CACHE_RETRY_RATE` (default: 0.0)
  - Evicts data on hash mismatch to maintain integrity

- **12-Hour Cache-Control Tier**: New middle tier for data that is unstable but
  from a trusted source (e.g., trusted bundlers), providing a three-tier system:
  stable (30d, immutable) > unstable trusted (12h) > unstable (2h)

- **Chunk Broadcast Improvements**: All 5 tip nodes (tip-1 through tip-5) are
  now included in default preferred chunk POST nodes, with shuffled ordering and
  a minimum success requirement
  - Controlled via `CHUNK_POST_MIN_PREFERRED_SUCCESS_COUNT` (default: 2)

- **OTEL Resource Attributes Passthrough**: Operators can set custom
  OpenTelemetry resource attributes via the standard
  `OTEL_RESOURCE_ATTRIBUTES` environment variable, with env var values
  overriding auto-detected attributes

- **Gateway Loop Prevention**: Per-gateway via-chain detection skips individual
  gateways already visited in the request path, with hop count validation
  against `MAX_DATA_HOPS` (3) as defense-in-depth. Client IP, forwarded IPs,
  and via header are now included as OTEL span attributes for observability.

### Changed

- Default `CDB64_REMOTE_RETRIEVAL_ORDER` changed to `'chunks'` only, removing
  gateways from the default order since range requests aren't effectively cached
  on gateways

### Fixed

- **Stream Reliability Improvements**: Replaced wall-clock stream timeouts with
  backpressure-aware stall-based timeouts (30s no-data threshold), preventing
  false kills and truncated responses on large or slow transfers
  - Extracted `pipeStreamToResponse` helper for consistent stream pipe and error
    handling across routes

- Fixed Axios `CanceledError` not being normalized to `AbortError`, causing
  incorrect upstream disconnection handling

- Fixed streams not being destroyed on unexpected HTTP status codes from peers,
  preventing socket leaks

- Added 206 Partial Content acceptance for ranged peer requests

- Fixed upstream stream not being destroyed on premature client disconnect

- Fixed `detectLoopInViaChain` to lowercase via entries for proper
  case-insensitive matching

## [Release 71] - 2026-02-26

This is a **recommended release** that adds **per-gateway trust configuration**
for `TRUSTED_GATEWAYS_URLS`, enabling operators to mark individual gateways as
trusted or untrusted for finer-grained data verification control. It also
includes **peer URL tracking in chunk broadcast responses** for improved
debuggability, and fixes for **upstream gateway content-length validation** to
prevent serving bogus responses from gateways that return 200 instead of 404.

### Added

- **Per-Gateway Trust Flag for `TRUSTED_GATEWAYS_URLS`**: Extended the
  `TRUSTED_GATEWAYS_URLS` configuration format to support per-gateway trust
  levels
  - Untrusted gateways only cache data when the hash matches a known value,
    providing defense-in-depth against serving incorrect data
  - Default configuration now uses `turbo-gateway.com` (trusted) with
    `arweave.net` as an untrusted fallback

- **Peer URL in Chunk Broadcast Responses**: Chunk broadcast responses now
  include the peer URL for better debuggability when troubleshooting chunk
  propagation issues

### Changed

- Default `TRUSTED_GATEWAYS_URLS` now uses `turbo-gateway.com` as the primary
  trusted gateway with `arweave.net` as an untrusted fallback

### Fixed

- **Upstream Gateway Content-Length Validation**: Added validation of
  content-length in `GatewaysDataSource` to reject responses with missing or
  zero content-length, preventing upstream gateways from serving bogus HTML
  landing pages when they return 200 instead of 404.

## [Release 70] - 2026-02-24

This is a **recommended release** that introduces **CDB64 download tooling** for
fetching remote partitioned indexes with resume support, **chunk request
concurrency limiting** and first-data timeouts for improved data retrieval
reliability, and **expanded CDB64 root TX index coverage** with new AO and
without-content-type index sources. It also includes critical fixes for event
listener leaks, stream data loss, and request cancellation under high
concurrency, along with **defense-in-depth loop protection** enhancements and a
new **auto-verify indexing tool** for cross-source bundle data validation.

### Added

- **CDB64 Download Tool**: New CLI tool (`tools/download-cdb64`) for fetching
  remote partitioned CDB64 indexes with production-grade reliability
  - Downloads partition files from manifest sources (HTTP URLs, Arweave TX IDs,
    byte-range specifications, local files)
  - HTTP Range request resume for interrupted downloads — partial `.tmp` files
    are preserved and downloads resume from where they left off
  - Per-partition retry support with configurable retry count (`--retries/-r`,
    default: 5)
  - Concurrent downloads with configurable parallelism (`--concurrency/-c`,
    default: 3)
  - SHA-256 verification of downloaded partitions against manifest checksums
  - Generates updated manifest with local file locations on completion

- **Streaming Partitioned CDB64 Writer**: New low-memory CDB64 generation mode
  for large indexes
  - Reduces peak memory from O(total_records) to O(largest_partition) via
    two-phase scatter/build approach
  - Phase 1 writes records to per-partition temp files; Phase 2 builds CDB files
    sequentially
  - New `--low-memory` flag added to all CDB64 CLI tools (requires
    `--partitioned`)
  - Progress callbacks show partition-level build status

- **AO and Without-Content-Type CDB64 Index Sources**: Expanded default CDB64
  root TX index coverage
  - New AO data items index (~1.6B records) covering AO-tagged data items up to
    block height 1,820,000
  - New without-content-type index (~1.2B records) covering data items lacking a
    Content-Type tag up to block height 1,820,000
  - Default `CDB64_ROOT_TX_INDEX_SOURCES` now includes all three indexes

- **Chunk Request Concurrency Limiting and First-Data Timeout**: New controls for
  chunk-based data retrieval under load
  - `CHUNK_REQUEST_CONCURRENCY` (default: 50): Limits concurrent chunk fetch
    requests to prevent overwhelming backends
  - `CHUNK_FIRST_DATA_TIMEOUT_MS` (default: 10000): Timeout for receiving the
    first chunk of data; if exceeded, request falls through to alternative data
    sources. Set to 0 to disable.

- **Root Bundle Gateway Fallback Path**: Added `/<id>` fallback path for root
  bundle gateway requests when `/raw/<id>` fails
  - Enables bundle retrieval from HyperBEAM endpoints that may not support the
    `/raw/<id>` path
  - Separate `rootBundleGatewaysDataSource` instance configured with fallback
    enabled

- **ArNS Resolver Host Override**: New `TRUSTED_ARNS_RESOLVER_HOST_HEADER`
  environment variable decouples connection target from Host header in ArNS
  resolver, with `__NAME__` placeholder substitution for dynamic values

- **Defense-in-Depth Loop Protection Improvements**: Additional
  safeguards against request forwarding loops between gateways
  - Hop count validation added to `GatewaysDataSource` (MAX_DATA_HOPS = 3)
  - Origin/IP blocking applied to peer forwarding path via
    `FilteredContiguousDataSource`
  - Startup warning when `TRUSTED_GATEWAYS_URLS` contains this gateway's own
    `ARNS_ROOT_HOST`, indicating a self-forwarding loop

- **Auto-Verify Indexing Tool**: New tool (`tools/auto-verify`) for cross-source
  bundle data comparison and indexing consistency validation
  - Indexes configurable block ranges, then compares data items across SQLite,
    Parquet, GraphQL, and independently-parsed raw bundles
  - Verifies field consistency: offset, size, ownerOffset, ownerSize,
    signatureOffset, signatureSize, rootParentOffset
  - Bundle indexing timeout (5 minutes) for graceful handling of slow indexing
  - Cache preserved by default for faster iteration across runs
  - Detailed discrepancy output shows data item ID, field name, and per-source
    values

- **Git Worktree Helper**: New development tool (`tools/wt`) for parallel
  development using git worktrees
  - Creates worktrees under `wt/<branch>` with symlinked `.env` and
    `CLAUDE.local.md`
  - Commands: `add`, `rm`, `ls` with `--existing` flag for checking out existing
    branches
  - Automatically runs `yarn install` with a clean `data/` directory per
    worktree

### Changed

- Default ArNS gateway changed from `ar-io.net` to `turbo-gateway.com`
- Default Arweave gateway in test suites changed from `arweave.net` to
  `turbo-gateway.com`
- Renamed AO CDB directory from `cdb64-root-tx-index-ao` to
  `cdb64-root-tx-index-ao-to-height-1820000` for naming consistency
- Removed unused Cucumber dependency

### Fixed

- **Stream Data Loss Prevention**: Fixed range stream being put into flowing mode
  prematurely, causing data to be emitted and lost before the consumer could
  attach
- **HTTP Request Cancellation**: Threaded AbortController through chunk timeout
  to properly cancel in-flight HTTP requests instead of only rejecting the
  promise
- **Timer Leaks**: Fixed timeout timer leaks in chunk request implementation by
  hoisting timeout variable for proper cleanup in finally blocks
- **Event Listener Leaks**: Replaced `AbortSignal.any()` with `anySignal()` from
  the `any-signal` package and added proper `ClearableSignal.clear()` calls in
  finally blocks across composite ArNS resolver and chunk request paths to
  prevent listener accumulation under high concurrency
- **CDB64 Config Order**: Fixed CDB64 root TX index source search order to
  preserve configuration order instead of sorting alphabetically
- **Data Item Tag Handling**: Content-Type and Content-Encoding tag processing
  now uses first match instead of last match, aligning with legacy gateway
  behavior
- **Docker Build**: Multi-stage Dockerfile now copies `resources/` directory into
  runtime stage so the default CDB64 manifest is accessible inside containers
- **Cache Directory Cleanup**: `.gitkeep` files properly recreated after cleaning
  cache directories
- **CDB64 Test Reliability**: Conditional test skipping when native CDB64 module
  is unavailable; direct module probing prevents async rejection leaks in CI
- **Dependency Security**: Updated axios (DoS via `__proto__`), tar (symlink/
  overwrite CVEs), qs (arrayLimit bypass DoS), fast-xml-parser (RangeError DoS),
  and other transitive dependencies with known vulnerabilities

## [Release 69] - 2026-02-11

This is a **recommended release** that introduces **DNS-based multi-peer
discovery** via Envoy's Endpoint Discovery Service, enabling automatic Arweave
peer detection with health-checked routing and consensus-based failover. It also
adds **multi-layered HyperBEAM request loop prevention** using header, via-chain,
and User-Agent detection to block infinite forwarding loops between gateways.
Additionally, this release includes **comprehensive CDB64 documentation** covering
operator guides, format specifications, and tooling reference.

### Added

- **DNS-Based Multi-Peer Discovery with Envoy EDS**: Automatic Arweave peer
  discovery and health-checked routing via Envoy's Endpoint Discovery Service
  - Resolves DNS records (e.g., `peers.arweave.xyz`) to discover Arweave peers
    automatically
  - Health-checks peers and classifies them as "full" (complete blockchain data)
    or "partial" (incomplete) based on sync status
  - Routes requests to fully-synced peers first with automatic failover to
    partial peers
  - Consensus-based reference height calculation prevents routing to stale or
    outlier peers
  - New Prometheus metrics for peer discovery, classification, and health check
    monitoring
  - Configurable via `ARWEAVE_PEER_DNS_RECORDS`, `ARWEAVE_PEER_DNS_PORT`,
    `ARWEAVE_PEER_HEALTH_CHECK_INTERVAL_MS`, and related environment variables
  - Enabled by default with `ENABLE_ARWEAVE_PEER_EDS=true`; falls back to
    static `TRUSTED_NODE_HOST` when disabled
  - EDS files validated on startup with corrupt files automatically removed and
    re-seeded

- **HyperBEAM Request Loop Prevention**: Multi-layered detection of
  compute-origin requests to prevent infinite forwarding loops between gateways.
  Local data sources (cache, S3, database) always continue to serve data
  normally.
  - **Header-based detection**: Requests with configured headers (default:
    `ao-peer-port`) are identified as compute-origin and blocked from remote
    forwarding. Configurable via `SKIP_FORWARDING_HEADERS`.
  - **Via-chain loop detection**: New `X-AR-IO-Via` header tracks the chain of
    gateway identities across hops. When a gateway detects its own identity in
    the via chain, it stops forwarding to prevent loops. Gracefully degrades when
    `ARNS_ROOT_HOST` is not configured.
  - **User-Agent detection**: Requests with missing or empty User-Agent headers
    skip remote forwarding by default, catching HTTP clients like Erlang's `gun`
    (used by HyperBEAM) that don't send a User-Agent. Configurable via
    `SKIP_FORWARDING_EMPTY_USER_AGENT` (default: `true`). Additionally,
    `SKIP_FORWARDING_USER_AGENTS` allows specifying User-Agent substrings for
    case-insensitive matching (e.g., `HyperBEAM`).

- **CDB64 Documentation**: Comprehensive documentation for the CDB64 root
  transaction index feature
  - Operator guide (`docs/cdb64-guide.md`) covering configuration, monitoring,
    custom index sources, and troubleshooting
  - Format specification (`docs/cdb64-format.md`) detailing the CDB64 binary
    format, key encoding, and location types
  - Tools reference (`docs/cdb64-tools.md`) documenting all 6 CDB64 CLI tools
    with usage examples
  - Overview page (`docs/cdb64.md`) linking all CDB64 documentation
  - Documentation index (`docs/INDEX.md`) providing a navigable overview of all
    gateway documentation
  - CDB64 section added to README for quick orientation
  - Glossary entries for CDB64-related terms
  - Fixed default values for `CDB64_CACHE_SIZE` and `CDB64_ROOT_TX_INDEX_SOURCES`
    in `docs/envs.md`
  - Build script (`tools/build-cdb64-napi`) for compiling the native CDB64
    N-API module from source

### Changed

- Updated observer to increase default chunk observation sample rate to 20%

## [Release 68] - 2026-02-04

This is an **optional release** that introduces **A/B testing infrastructure for data sources** via the
new `SamplingContiguousDataSource`, enabling operators to safely evaluate
alternative retrieval strategies with controlled traffic exposure and built-in
metrics. It also includes **CDB64 location type renames** for improved clarity in
manifest schemas, and **data retrieval tooling enhancements** with content
validation options for easier gateway comparison testing.

### Added

- **SamplingContiguousDataSource for A/B Testing**: New data source wrapper that
  probabilistically routes requests through an experimental source
  - Enables safe A/B testing of new retrieval strategies with controlled traffic
    exposure
  - Two sampling strategies: `random` (per-request) or `deterministic`
    (consistent per ID using SHA-256 hash)
  - Configurable sampling rate (0-1) with validation to reject invalid values
  - New Prometheus metrics: `sampling_decision_total`, `sampling_request_total`,
    `sampling_latency_ms`
  - OpenTelemetry span instrumentation for sampled requests

- **Data Retrieval Tool Enhancements**: New options in `tools/test-data-retrieval`
  for content validation
  - `--bytes <n>`: Fetch first N bytes using HTTP Range headers for content
    comparison
  - `--max-size <bytes>`: Two-phase retrieval (HEAD then GET) for content under
    size threshold
  - RPS (requests per second) statistics in console and JSON output
  - SHA-256 hash computation for content comparison between gateways

### Changed

- **CDB64 Arweave Location Type Renames**: Renamed location types in CDB64
  manifests for clarity
  - `arweave-tx` → `arweave-id` (field: `txId` → `id`)
  - `arweave-bundle-item` → `arweave-byte-range` (field: `txId` → `rootTxId`,
    `offset` → `dataOffsetInRootTx`, added optional `dataItemId`, removed `size`
    from location)
  - Includes script to add `dataItemId` fields by reading ANS-104 headers
  - Updated bundled manifest with new format

## [Release 67] - 2026-01-29

This is a **recommended release** focusing on **CDB64 index accessibility** and
**operational observability**. CDB64 lookups are now enabled by default with a
shipped manifest covering data items up to block height 1,820,000, eliminating
the need for operators to generate or configure their own indexes. New
Prometheus metrics provide detailed visibility into root TX index and ANS-104
offset lookup performance. The release also includes tooling for uploading
partitioned CDB64 indexes to Arweave and an observer update with network gateway
fallback for more resilient reference resolution.

### Added

- **CDB64 Upload Tool**: New CLI tool (`tools/upload-cdb64-to-arweave`) to upload
  partitioned CDB64 indexes to Arweave via Turbo SDK
  - Three-phase workflow: upload partitions, poll for bundle offsets, upload
    manifest
  - Supports concurrent uploads with configurable parallelism (`--concurrency`)
  - Resumable: saves progress to output manifest, restart with `--resume`
  - Dry-run mode for cost estimation before uploading
  - Optional L1 manifest upload for permanent on-chain storage

- **Default Remote CDB64 Index**: Ships with a pre-built CDB64 manifest for
  remote index lookups on Arweave
  - Covers non-AO, non-Redstone data items with content types up to block height
    1,820,000
  - CDB lookups now enabled by default in `ROOT_TX_LOOKUP_ORDER`
    (`db,gateways,cdb,graphql`)
  - Default `CDB64_ROOT_TX_INDEX_SOURCES` points to shipped manifest

- **Prefix-Partitioned CDB64 Indexes**: CDB64 root TX indexes can now be split
  across 256 partition files based on key prefix
  - Each partition file (00.cdb - ff.cdb) contains records for keys starting
    with that byte
  - Enables parallel processing and reduces memory requirements for large
    indexes
  - Manifest file tracks partition metadata and record counts
  - Tools updated: `generate-cdb64-root-tx-index` and
    `generate-cdb64-root-tx-index-rs` support `--partitioned` flag

- **HTTP Request Concurrency Limit for Remote CDB64 Sources**: New environment
  variables limit concurrent HTTP requests across all remote CDB64 sources
  - `CDB64_REMOTE_MAX_CONCURRENT_REQUESTS`: Global limit on concurrent HTTP
    requests (default: 4)
  - `CDB64_REMOTE_SEMAPHORE_TIMEOUT_MS`: Maximum time to wait for a request slot
    before failing (default: 5000ms)
  - Prevents request pile-up when reading CDB files from HTTP/S3 endpoints
  - Requests exceeding the timeout fail fast rather than waiting indefinitely

- **Prometheus Metrics for Root TX Index and ANS-104 Offset Lookups**: New
  instrumentation to track lookup performance, cache effectiveness, and data
  source usage
  - `root_tx_lookup_total`: Per-source lookups by status and offset availability
  - `root_tx_lookup_duration_ms`: Per-source lookup latency
  - `root_tx_cache_hit_total` / `root_tx_cache_miss_total`: LRU cache
    effectiveness tracking
  - `composite_root_tx_lookup_total`: Final lookup outcome with winning source
  - `composite_root_tx_lookup_duration_ms`: Total composite lookup duration
  - `ans104_offset_lookup_total`: Offset lookups by method (`path_guided` vs
    `linear_search`)
  - `ans104_offset_lookup_duration_ms`: Offset lookup latency by method
  - `ans104_offset_path_depth`: Histogram of bundle nesting depth (buckets: 2,
    3, 4)

### Changed

- **Observer Update to `8fb7b2f`**: Updated observer with network gateway
  fallback for reference resolution
  - When explicit reference gateways fail or disagree, the observer now falls
    back to querying healthy gateways from the AR.IO network for consensus
  - Three operating modes: explicit only, explicit + network fallback (default),
    or network only for fully decentralized observation
  - New `REFERENCE_GATEWAY_HOSTS` supports multiple comma-separated fallback
    gateways with sequential failover
  - Network consensus uses configurable gateway selection criteria (pass rate,
    consecutive passes, epoch count) with stale-while-error caching
  - Treats 404/410 responses as authoritative "chunk not found" to avoid
    unnecessary network fallback queries
  - New metrics: `observer_network_fallback_total`,
    `observer_network_consensus_agreement`, `observer_network_eligible_gateways`
  - See `docs/envs.md` for full configuration options

### Fixed

- Updated `TRUSTED_ARNS_GATEWAY_URL` default value in documentation from
  `arweave.dev` to `ar-io.net` to match the actual code default

## [Release 66] - 2026-01-21

This is a **recommended release** focusing on **nested bundle performance** and
**resource stability**. Key improvements include path-based CDB64 indexes that
enable O(n) navigation through deeply nested bundles (vs O(n*m) previously), new
CDB64 verification tools for validating index completeness, and several fixes
for stream leaks and file descriptor exhaustion. Abort signal handling has also
been extended to contiguous data requests, preventing wasted work when clients
disconnect.

### Added

- **Nested Bundle Path Support**: CDB64 root TX indexes now support path-based
  formats for efficient retrieval of deeply nested data items
  - New value formats: path-only `{p}` and path-complete `{p, i, d}` store the
    bundle hierarchy from root to parent
  - Enables O(n) navigation through nested bundles instead of O(n*m) linear
    search at each level
  - GraphQL parent chain traversal now collects and returns path information
  - `Ans104OffsetSource` uses path-guided navigation with fallback to legacy
    behavior
  - CDB64 tools updated to generate and export path-based indexes

- **Reference Gateway Comparison in Data Retrieval Tool**: New `--reference`
  option in `tools/test-data-retrieval` compares responses against a reference
  gateway
  - Compares status codes, Content-Length, and Content-Type headers
  - Shows detailed mismatch info in verbose mode
  - Includes comparison stats in summary and JSON output

- **CDB64 Verification Tool**: New CLI tool for validating CDB64 root TX index
  completeness (`tools/verify-cdb64`)
  - Random and sequential sampling modes for efficient verification of large
    indexes
  - Value comparison mode to validate stored values match actual gateway
    responses
  - Detailed statistics on index coverage and discrepancies

- **CDB64 Verification in Data Retrieval Tool**: The data retrieval test tool
  now verifies CDB64 index entries for every tested ID, reporting match rates
  and discrepancies

### Changed

- **Abort Signal Propagation to Data Requests**: Extended abort signal handling
  to contiguous data sources
  - Client disconnections now abort all in-flight data requests, not just chunk
    requests
  - Prevents wasted bandwidth and resources on abandoned data transfers

### Fixed

- **Stream Leak in ANS-104 Worker**: Fixed stream not being properly destroyed
  in `hashDataItemData` function, which could cause file descriptor exhaustion
  during bundle processing

- **Stream Leak in Data-Root Worker**: Fixed read stream not being destroyed
  after use, preventing file descriptor leaks during data root verification

- **fs-cleanup-worker Resource Exhaustion**: Improved cleanup worker to reduce
  file descriptor pressure
  - Throttled concurrent file deletes to prevent overwhelming the filesystem
  - Reduced parallel file operations during cleanup cycles

- **Abort Signal Race Condition in Cached Chunk Requests**: Fixed a race
  condition in `ArIOChunkSource` where subsequent callers could not abort their
  requests when sharing a cached promise
  - Added `withAbortSignal()` helper that races a promise against the caller's
    abort signal
  - Each caller now respects their own abort signal independently when using
    cached chunk promises

## [Release 65] - 2026-01-14

This is a **recommended release** focusing on **resource stability** and **remote
index distribution**. Key improvements include AbortSignal propagation through
the chunk retrieval pipeline to prevent wasted work when clients disconnect,
reduced parallel peer requests and concurrency limits to lower resource pressure,
and the ability to load CDB64 root TX indexes from remote sources (Arweave
transactions, bundle data items, or HTTP URLs). Several high-severity dependency
vulnerabilities have also been addressed.

### Added

- **Remote CDB64 Index Sources**: CDB64 root TX indexes can now be loaded from
  remote sources in addition to local files (GitHub #569)
  - Arweave transactions: specify a 43-character TX ID
  - Bundle data items: use `txId:offset:size` format for indexes stored within bundles
  - HTTP URLs: load indexes from S3, CDNs, or dedicated index servers
  - New environment variables:
    - `CDB64_ROOT_TX_INDEX_SOURCES`: comma-separated list of sources (local paths,
      TX IDs, bundle items, URLs)
    - `CDB64_REMOTE_RETRIEVAL_ORDER`: data sources for fetching remote indexes
      (gateways, chunks, tx-data)
    - `CDB64_REMOTE_CACHE_MAX_REGIONS`: max cached byte-range regions per source
    - `CDB64_REMOTE_CACHE_TTL_MS`: TTL for cached regions
    - `CDB64_REMOTE_REQUEST_TIMEOUT_MS`: request timeout for remote sources
  - Intelligent caching: CDB64 headers (4KB) cached permanently, other regions
    use LRU cache with configurable size and TTL

- **Chunk Retrieval Load Testing Tool**: New CLI tool for load testing chunk
  retrieval endpoints (`tools/test-chunk-retrieval`)
  - Configurable concurrency with `--concurrency` flag (default: 10)
  - Duration mode (`--duration`) and count mode (`--count`) for flexible testing
  - File descriptor tracking (`--track-fds <pid>`) for resource monitoring
  - Error categorization with resource exhaustion detection (EMFILE, etc.)
  - Response time percentiles and requests/second metrics

### Changed

- **AbortSignal Propagation in Chunk Retrieval**: Client disconnections now
  abort all downstream operations promptly
  - Adds middleware that attaches AbortSignal to all requests
  - Propagates signal through retrieval service, composite sources, and caches
  - Returns HTTP 499 status for client-aborted requests
  - Prevents wasted work when clients disconnect during chunk requests

- **Reduced Parallel Peer Requests**: Lowered parallel peer request count from
  3 to 2 to reduce resource pressure during chunk retrieval

- **Chain Fallback Concurrency Limit**: Added concurrency limit to
  CompositeTxBoundarySource for chain fallback operations to prevent resource
  exhaustion from expensive binary search operations

- **Node.js Update**: Bumped Node.js from 20.11.1 to 20.19.6 (latest available
  Docker image)

- **Dependency Security Updates**: Addressed high-severity vulnerabilities
  - Added resolution for `qs@6.14.1` (fixes DoS via memory exhaustion in Express)
  - Added resolution for `cookie@0.7.0` (fixes out-of-bounds character handling)
  - Updated `@aws-sdk/client-dynamodb` and `@aws-sdk/credential-providers` to
    3.968.0

### Fixed

- **Abort Losing Parallel Peer Requests**: Parallel peer chunk requests now
  properly abort when one peer succeeds, freeing resources immediately instead
  of letting losing requests complete wastefully

- **Dead TxOffsetSource Code Removed**: Removed obsolete TxOffsetSource
  implementation files that were superseded by TxBoundarySource refactor

## [Release 64] - 2026-01-07

This is an **optional release** focusing on observer improvements and container
reliability. Key changes include the updated observer with continuous observation
mode support and explicit file descriptor limits for core and envoy services that
may improve reliability for some operators.

### Changed

- **Observer Update**: Updated observer to version `e34a7f0` with continuous
  observation mode support
  - New `OBSERVER_STATE_PATH` environment variable for configuring observer
    state storage location (default: `./data/observer`)
  - Added volume mount for observer state persistence across container restarts
  - Increased default chunk observation sample rate to 10%

- **File Descriptor Limits**: Added explicit `ulimits` configuration for core
  and envoy services in docker-compose.yaml
  - Sets `nofile` soft/hard limits to 65536 for both services
  - Ensures consistent behavior across different host configurations
  - May help resolve connection issues some operators have been experiencing

## [Release 63] - 2025-12-22

This is an **optional release** focusing on operator tooling and observability
improvements. Key additions include a data retrieval testing tool for gateway
validation, separate credentials support for legacy S3 chunk sources, and
OTEL-Winston integration for distributed trace correlation in logs.

### Added

- **CDB64 Extension Support**: Accept `.cdb64` file extension in addition to
  `.cdb` for CDB64 root TX index files

- **Data Retrieval Testing Tool**: New CLI tool for testing data item retrieval
  from a gateway using TX/data item IDs from a CSV file
  (`tools/test-data-retrieval`)
  - Sequential mode: streams through file line by line
  - Random mode: O(1) random byte seeking, no file scan required
  - Continuous mode: runs indefinitely until Ctrl+C, writes JSON results to file
  - Configurable concurrency for parallel requests
  - Comprehensive statistics: success/failure rates, response time percentiles
    (p50/p95/p99), cache hit rates, status codes, bytes transferred
  - Console table and JSON output formats

- **Separate Credentials for Legacy S3 Chunk Source**: Add ability to configure
  separate AWS credentials for the legacy S3 chunk data source, enabling access
  to S3 buckets in different AWS accounts
  - `LEGACY_AWS_S3_ACCESS_KEY_ID`: AWS access key for legacy S3 bucket
  - `LEGACY_AWS_S3_SECRET_ACCESS_KEY`: AWS secret key for legacy S3 bucket
  - `LEGACY_AWS_S3_REGION`: AWS region (required when using separate credentials)
  - `LEGACY_AWS_S3_ENDPOINT`: Custom endpoint (optional)
  - Falls back to main AWS client when legacy credentials are not set

- **Docker Compose Environment Variables**: Expose additional environment
  variables in docker-compose.yaml for legacy chunk sources and chunk
  rebroadcasting
  - Legacy S3/PostgreSQL chunk source configuration
  - Chunk rebroadcast rate limiting and deduplication settings

- **OTEL Winston Integration for Trace ID Correlation**: Automatic injection of
  OpenTelemetry trace context (`trace_id`, `span_id`, `trace_flags`) into all
  Winston log entries, enabling correlation of logs with distributed traces
  - All logs within a request share the same `trace_id` for easy filtering
  - Spans properly nested via `span_id` for hierarchical trace analysis
  - Request handlers (data, chunk, ArNS) wrapped with active OTEL context
  - ArNS middleware includes span attributes for resolution timing and results
  - `startChildSpan()` helper auto-detects parent from active context

### Fixed

- Fix missing `parentSpan` parameter in `handleRangeRequest` calls for proper
  OTEL trace hierarchy in range requests

## [Release 62] - 2025-12-14

This is an **optional release** that introduces the CDB64-based historical root
TX index, a new lookup source for resolving data items to their root
transactions. The CDB64 format provides fast O(1) lookups from pre-generated
index files, enabling efficient root TX resolution for historical data without
database queries. Pre-generated CDB64 index files will be made available in the
coming weeks.

### Added

- **CDB64-Based Historical Root TX Index**: New lookup source for root
  transaction IDs using the compact CDB64 file format
  - Enable by adding 'cdb' to `ROOT_TX_LOOKUP_ORDER` (e.g.,
    `db,cdb,gateways,graphql`)
  - Reads from `data/cdb64-root-tx-index` directory (configurable via
    `CDB64_ROOT_TX_INDEX_DATA_PATH` in Docker)
  - Multi-file directory support with runtime file watching (new `.cdb` files
    automatically loaded without restart)
  - File watching can be disabled via `CDB64_ROOT_TX_INDEX_WATCH=false`
  - CLI tools for index generation and data extraction:
    - SQLite to CDB64 export (`tools/export-sqlite-to-cdb64`)
    - CSV to CDB64 generation with RFC 4180 support
      (`tools/generate-cdb64-root-tx-index`)
    - Rust-backed CDB64 generation for high-throughput
      (`tools/generate-cdb64-root-tx-index-rs`)
    - CDB64 to CSV export (`tools/export-cdb64-root-tx-index`)
  - Binary compatibility with Rust cdb64-rs for cross-language interoperability
  - CDB64 file format specification documentation (`docs/cdb64-format.md`)

### Fixed

- Expose `ROOT_TX_LOOKUP_ORDER` environment variable in docker-compose.yaml
  (was missing from previous releases)

## [Release 61] - 2025-12-10

This release addresses potential memory growth issues observed on some r60 nodes
by converting unbounded caches to bounded LRU caches and adding cleanup for
stale peer chunk queues. Users currently on r60 experiencing memory issues
should upgrade. Users on earlier releases may want to wait until these
improvements have been confirmed in production.

### Changed

- **Observer Performance Improvements**: Updated bundled observer with chunk
  verification optimizations ported from ar-io-node
  - TX path Merkle proof parsing eliminates 7-10 API calls per chunk by
    extracting transaction boundaries directly from tx_path
  - Pre-computed offset-to-block mapping narrows binary search range by 97-99%
    (from ~1.8M to ~26K blocks)

### Fixed

- **Memory Leak Prevention**: Address potential memory growth vectors identified
  during OOM investigation on low-memory nodes
  - Add hourly cleanup of stale `peerChunkQueues` entries for peers no longer in
    the active peer list (only removes idle queues)
  - Convert `blockByHeightPromiseCache` and `txPromiseCache` from unbounded
    NodeCache to LRUCache with size limits (1000 blocks, 10000 transactions)
  - Convert SQLite dedupe caches (`insertDataHashCache`,
    `saveDataContentAttributesCache`) from unbounded NodeCache to LRUCache
    (10000 entries each)
  - Add `arweave_peer_chunk_queues_size` Prometheus gauge for monitoring

## [Release 60] - 2025-12-03

This is a **recommended release** due to significant chunk retrieval performance
improvements. AR.IO peer chunk fetching now uses parallel requests, reducing
worst-case latency from ~150 seconds to ~4 seconds. Additional optimizations
include tx_path Merkle proof validation to avoid expensive chain binary
searches, offset-based chunk cache lookups via symlinks, and a static
offset-to-block mapping that reduces block search iterations by ~29%.

### Added

- **OTEL Nested Bundle Sampling Policies**: Add targeted tail-sampling policies
  to detect scenarios where nested bundle offset issues could occur
  - `nested-bundle-policy`: Samples traces with `turbo.offsets_has_parent=true`
    (default: 5%, configurable via `OTEL_TAIL_SAMPLING_NESTED_BUNDLE_RATE`)
  - `offset-overwrite-risk-policy`: Samples traces where both offsets AND raw
    data paths executed (default: 10%, configurable via
    `OTEL_TAIL_SAMPLING_OFFSET_OVERWRITE_RATE`)
  - Adds `turbo.cache_path` diagnostic span attribute to identify which caching
    code path was used (rootParentInfo, parentInfo, or rawData)

- **Chunk Rebroadcasting**: Optional wrapper that asynchronously rebroadcasts
  chunks from configured sources (e.g., legacy S3) to the Arweave network
  - Fire-and-forget pattern that never blocks chunk fetches
  - Configurable via `CHUNK_REBROADCAST_SOURCES` environment variable
  - Includes rate limiting, deduplication cache, and concurrency controls
  - Disabled by default (empty `CHUNK_REBROADCAST_SOURCES`)

- **Block Search Optimization**: Ship static offset-to-block mapping to optimize
  binary search when looking up transactions by offset
  - Reduces block search iterations from ~21 to ~15 (~29% reduction)
  - Most significant impact during cold starts when block caches are empty
  - Each saved iteration means one fewer network call to fetch a block
  - Includes generation tool (`tools/generate-offset-mapping`) for updating
    mapping before releases

- **Chunk POST Early Termination and Smart Status Codes**: Reduce wasted
  resources on invalid chunk uploads and improve client error feedback
  - Early termination: Stop broadcasting after N consecutive 4xx failures when
    no peers have accepted the chunk (~96% reduction in wasted requests)
  - Smart status codes: Return most common peer error code instead of hardcoded
    500 (e.g., 400 for invalid chunks, 504 for timeouts)
  - New `CHUNK_POST_MAX_CONSECUTIVE_FAILURES` config variable (default: 5)
  - Only 4xx responses count toward consecutive failures (timeouts/5xx reset counter)

- **tx_path Chunk Validation**: Optimize chunk retrieval with a DB-first lookup
  strategy that falls back to tx_path Merkle proof validation for unindexed data
  - Lookup order: Database (fastest) → tx_path validation → Chain binary search (slowest)
  - tx_path proofs are cryptographically validated against the block's tx_root
  - Eliminates expensive chain binary search when tx_path is available from peers

- **Chunk Cache by Absolute Offset**: Enable chunk cache lookups by absolute
  weave offset for faster retrieval when chunk data is already cached
  - Creates symlinks indexed by absolute offset for O(1) cache lookups
  - Background worker periodically cleans up dead symlinks when cached data expires
  - Configurable via `ENABLE_CHUNK_SYMLINK_CLEANUP` (default: true) and
    `CHUNK_SYMLINK_CLEANUP_INTERVAL` (default: 24 hours)

### Changed

- **AR.IO Peer Chunk Retrieval Optimization**: Improved chunk retrieval
  performance from AR.IO network peers
  - Reduced per-peer request timeout from 10 seconds to 1 second
  - Changed from sequential to parallel peer requests (3 peers raced simultaneously)
  - Reduced retry strategy from 5 attempts to 2 attempts with different peers
  - Selects all peers upfront to ensure different peers on each retry attempt
  - Worst-case latency reduced from ~150 seconds to ~4 seconds
  - Maximum peer requests reduced from 15 to 6

## [Release 59] - 2025-11-24

This is a **recommended release** due to important fixes for nested bundle data
item offset handling that could cause incorrect data retrieval. The release
fixes offset calculations in both the TurboDynamoDB data source and database
root TX lookups, ensuring correct data is served for deeply nested bundle
items. It also includes fixes for ArNS manifest path encoding and Observer
wallet failure reporting for shared FQDN gateways. New features include a
dry-run mode for testing transaction uploads without posting to the network,
and a monitoring tool for historical DHA chunk nodes.

### Added

- **Historical DHA Chunk Nodes Monitoring Tool**: New operator utility for
  monitoring response times and availability of Arweave data endpoints
  (`tools/monitor-historical-dha-chunk-nodes`)
  - Monitors data-N (1-17) and tip-N (1-5) endpoints with configurable ranges
  - Continuous monitoring mode with real-time table output and statistics
  - JSON export with detailed results and metadata
  - Note: This is a special-purpose tool included for reference and potential
    usefulness to operators debugging data retrieval issues

- **Dry-Run Mode for Upload Testing**: New `ARWEAVE_POST_DRY_RUN` environment
  variable enables testing transaction and chunk uploads without posting to the
  Arweave network
  - When enabled, both `POST /tx` and `POST /chunk` requests are simulated with
    200 OK responses
  - Works on both port 3000 (Envoy) and port 4000 (direct to Node.js app)
  - Envoy routing is conditional: routes to core for dry-run, to Arweave nodes
    when disabled
  - Perfect for testing apps like ArDrive and large uploads without burning AR
    tokens
  - By default, transactions are validated (signature verification) and chunks
    are validated (merkle proof verification) before returning success
  - Set `ARWEAVE_POST_DRY_RUN_SKIP_VALIDATION=true` to skip validation for faster
    testing
  - Only the final network broadcast is skipped

### Changed

- When CDP API keys are provided (`CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`),
  the gateway now automatically uses the Coinbase facilitator with enhanced
  Onramp integration, overriding the `X_402_USDC_FACILITATOR_URL` setting

### Fixed

- **PostgreSQL SSL Configuration**: Fixed inverted SSL flag logic where
  `LEGACY_PSQL_SSL_REJECT_UNAUTHORIZED=true` (default) was incorrectly disabling
  certificate validation instead of enabling it
  - Now correctly applies strict SSL validation by default
  - Set to `false` to disable certificate validation for cloud providers with
    self-signed certificates

- **PostgreSQL Connection Timeouts**: Added timeout configuration for the legacy
  PostgreSQL chunk metadata source to prevent system hangs
  - Server-side `statement_timeout` (default: 5s) prevents queries from running
    forever
  - `idle_in_transaction_session_timeout` (default: 10s) cleans up stuck
    transactions
  - Connection pool settings: `max`, `idle_timeout`, `connect_timeout`,
    `max_lifetime`
  - All settings configurable via environment variables
    (`LEGACY_PSQL_STATEMENT_TIMEOUT_MS`, etc.)
  - Graceful Postgres connection cleanup on shutdown
  - Prevents the chunk serving system from becoming completely unresponsive when
    Postgres is slow or unreachable

- **Security Dependency Updates**: Fixed 6 security vulnerabilities identified by
  `yarn audit`
  - Added `tar@7.5.2` resolution to fix moderate severity race condition in
    duckdb-async dependency chain
  - Upgraded `@cucumber/cucumber`, `@testcontainers/localstack`, `testcontainers`,
    and `rimraf` to fix high severity glob CLI command injection vulnerabilities
  - Upgraded `viem` to ^2.39.3
  - All existing resolutions (secp256k1, elliptic, ws, semver) remain required for
    vulnerabilities in `@dha-team/arbundles` transitive dependencies

- **ArNS Manifest Path Encoding**: Fixed manifest paths with URL-encoded
  characters (e.g., spaces as `%20`) failing when accessed via ArNS subdomain
  - Direct TX ID access worked because Express auto-decodes `req.params`
  - ArNS subdomain access failed because `req.path` is not auto-decoded
  - Now decodes manifest paths in the ArNS middleware for consistent behavior
- **TurboDynamoDB Data Source**: Fixed nested bundle data items having incorrect
  `rootDataItemOffset` values when retrieved from Turbo's DynamoDB
  - The raw data path was overwriting correct absolute offsets cached from the
    `rootParentInfo` path with incorrect values (offset: 0, dataOffset: payloadDataStart)
  - Now preserves the correct offsets by only caching size and contentType from raw data
- **Database Root TX Offset Lookup**: Fixed `getRootTxFromData` returning incorrect
  offset for nested bundle data items
  - Was returning `root_parent_offset` (parent bundle offset) instead of
    `root_data_item_offset` (absolute data item offset)
  - Added fallback calculations for `rootDataItemOffset` and `rootDataOffset` when
    pre-computed values are NULL
- **Observer**: Updated to 2515e6a - Fixed incorrect wallet failure reporting
  for shared FQDN gateways
  - When multiple wallets share the same FQDN, now correctly identifies which
    specific wallets failed ownership verification
  - Reports non-matching wallets as failed even when gateway passes overall
  - Ensures save-observations contract interactions accurately reflect actual
    ownership failures
- BUNDLER_URLS environment variable was missing from docker-compose.yaml
- x402 payment processor now correctly uses Coinbase CDP facilitator when CDP
  credentials are configured

## [Release 58] - 2025-11-10

This is a **recommended release** due to significant improvements in data
retrieval efficiency and payment system reliability. This release introduces a
new raw binary chunk data endpoint providing ~40% bandwidth savings,
comprehensive rate limit balance management APIs, and intelligent OpenTelemetry
tail-based sampling for cost-effective observability. The release also includes
critical payment validation fixes and enhanced bundler service discovery for
improved client integration.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Raw Binary Chunk Data Endpoint**: New `/chunk/<offset>/data` endpoint
  returns raw binary chunk data (`application/octet-stream`) with metadata in
  response headers instead of base64url-encoded JSON
  - Provides ~40% bandwidth savings compared to the base64url-encoded
    `/chunk/<offset>` endpoint
  - Supports both GET and HEAD requests
  - Returns comprehensive metadata in custom headers:
    - `X-Arweave-Chunk-Data-Path` - Base64url-encoded merkle proof path for
      chunk verification
    - `X-Arweave-Chunk-Data-Root` - Merkle tree root hash
    - `X-Arweave-Chunk-Start-Offset` - Absolute start offset of chunk in the
      weave
    - `X-Arweave-Chunk-Relative-Start-Offset` - Chunk offset relative to its
      transaction's data
    - `X-Arweave-Chunk-Read-Offset` - Number of bytes to skip from the start
      of the returned chunk to reach the requested offset
    - `X-Arweave-Chunk-Tx-Data-Size` - Total data size of the transaction
      containing this chunk
    - `X-Arweave-Chunk-Tx-Id` - Transaction ID containing this chunk
    - `X-Arweave-Chunk-Tx-Start-Offset` - Absolute start offset of the
      transaction in the weave
    - `X-Arweave-Chunk-Tx-Path` - Transaction-level merkle path (when available)
    - `X-Arweave-Chunk-Source` - Data source identifier (e.g., `arweave`,
      `trusted-gateway`)
    - `X-Arweave-Chunk-Source-Version` - Version identifier of the data source
  - Supports ETag-based conditional requests (304 Not Modified)
  - Supports `Content-Digest` header (RFC 9530) for data integrity verification
  - Rate limited at 256 KiB (raw chunk size) vs. 360 KiB for base64url
    endpoint, resulting in lower per-chunk fees
- **Bundler Service Discovery**: The `/ar-io/info` endpoint now includes a
  `bundlers` field for client service discovery
  - Configurable via `BUNDLER_URLS` environment variable (comma-separated URLs)
  - Defaults to `https://turbo.ardrive.io/`
  - URLs are validated on startup with descriptive error messages
  - Returns array of objects with `url` property
  - Enables clients to discover available bundler services for data uploads
- **Rate Limit Balance Management API**: New REST API endpoints for querying
  and managing rate limit bucket balances
  - `GET /ar-io/rate-limit/ip/:ip` - Query IP-based rate limit bucket balance
  - `POST /ar-io/rate-limit/ip/:ip` - Top up IP-based bucket via x402 payment
    or admin API key
  - `GET /ar-io/rate-limit/resource` - Query resource-based bucket balance with
    optional query parameters (`method`, `resource`, `host`)
  - `POST /ar-io/rate-limit/resource` - Top up resource-based bucket via x402
    payment or admin API key
  - Dual authentication: x402 payment protocol (public) or admin API key
    (private/testing via `ADMIN_API_KEY` environment variable)
  - 10x capacity multiplier applied to x402 payments compared to raw admin
    top-ups
  - Smart defaults for resource endpoints (method defaults to GET, host
    defaults to current request host)
  - Enables programmatic balance queries and top-ups for testing and automated
    payment workflows
- **OpenTelemetry Collector with Tail-Based Sampling** ⚠️ **EXPERIMENTAL**: New
  OTEL Collector sidecar in docker-compose deployments implements intelligent
  tail-based sampling to reduce telemetry costs by 80-95% while maintaining
  complete visibility into errors, performance issues, and paid traffic. This
  feature is experimental and subject to change in future releases
  - Five intelligent sampling policies make decisions after traces complete:
    - 100% of traces with errors (5xx responses, exceptions)
    - 100% of slow requests exceeding configurable threshold (default: 2 seconds)
    - 100% of x402 verified payment requests for billing and compliance
    - 100% of paid rate limit token usage for revenue tracking
    - 1% (configurable) of successful, fast, unpaid requests for baseline metrics
  - Traces flow through architecture: ar-io-node → otel-collector → telemetry backend
  - Support for multiple telemetry backends via environment variables:
    - Honeycomb (`OTEL_COLLECTOR_HONEYCOMB_API_KEY`)
    - Grafana Cloud Tempo (`OTEL_COLLECTOR_GRAFANA_CLOUD_API_KEY`)
    - Datadog (`OTEL_COLLECTOR_DATADOG_API_KEY`)
    - New Relic (`OTEL_COLLECTOR_NEW_RELIC_API_KEY`)
    - Elastic APM (`OTEL_COLLECTOR_ELASTIC_API_KEY`)
  - Configurable sampling rates for each policy via environment variables:
    - `OTEL_TAIL_SAMPLING_SUCCESS_RATE` - Baseline success sampling (default: 1%)
    - `OTEL_TAIL_SAMPLING_SLOW_THRESHOLD_MS` - Slow request threshold (default: 2000ms)
    - `OTEL_TAIL_SAMPLING_ERROR_RATE` - Error sampling rate (default: 100%)
    - `OTEL_TAIL_SAMPLING_SLOW_RATE` - Slow request sampling rate (default: 100%)
    - `OTEL_TAIL_SAMPLING_PAID_TRAFFIC_RATE` - Paid traffic sampling (default: 100%)
    - `OTEL_TAIL_SAMPLING_PAID_TOKENS_RATE` - Paid token sampling (default: 100%)
  - Optional deployment via docker-compose profile (`docker compose --profile otel up`)
  - Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318` when using the
    profile, or configure it to send traces directly to an external backend to
    bypass the local collector
  - Enhanced span attributes for paid traffic tracking including client IP,
    payment verification status, and token consumption

### Changed

- **Chunk Request Routing**: Removed Envoy proxy route for GET `/chunk/`
  requests - all chunk endpoints now route directly to the AR.IO gateway
  application instead of being proxied to trusted Arweave nodes. This enables
  rate limiting, x402 payment processing, and local caching for chunk requests
- **Transaction-Level Merkle Path Support**: The `/chunk/<offset>` endpoint now
  includes `tx_path` in JSON responses when available (both GET and HEAD
  requests), providing transaction-level merkle proofs
- **Observer**: Updated to fcd0f36 - Doubled offset observation sample rate to
  2% for improved network robustness
- **AR.IO Info Endpoint Structure**: The `bundlers` field in `/ar-io/info`
  endpoint response is now nested under `services.bundlers` instead of being a
  top-level field for improved API organization and future extensibility
- **Rate Limiter Bucket Keys**: Standardized bucket key format across Redis and
  Memory rate limiter implementations - extracted shared utility functions to
  `src/limiter/utils.ts` for consistent key generation
- **Browser Paywall for Chunk Requests**: Optimized payment flow for chunk
  endpoints (`/chunk/*`) in browser paywall mode to use direct URL payment
  instead of redirect endpoint
  - **Browser only**: This optimization only affects requests detected as browser
    requests (Accept includes text/html AND User-Agent includes Mozilla)
  - **API flows unchanged**: Programmatic API payments continue to work the same
    way for all endpoints
  - Reduces latency by eliminating redirect round-trip for small chunk requests
  - Paywall sends payment directly to original chunk URL with x-payment header
  - Payment verification, settlement, and token granting happen inline before
    serving content
  - Other browser endpoints (transactions, manifests) continue using redirect
    endpoint for larger content
  - Both approaches use the same payment verification and settlement process

### Documentation

- Updated OpenAPI specification with comprehensive documentation for new
  `/chunk/<offset>/data` endpoint (GET and HEAD methods)
- Improved OpenAPI specification with complete header documentation for
  transaction data and chunk endpoints, including ANS-104 bundle navigation
  headers, data verification headers, and detailed examples with offset
  calculations
- Updated rate limiting documentation to include both chunk endpoint pricing
  models
- Updated glossary to reference both chunk endpoint formats
- Updated x402 and rate limiting documentation to explain chunk-specific direct
  payment flow and general redirect flow for browser paywall requests

### Fixed

- **Payment Processor and x402 Validation**: Multiple improvements to payment
  validation and error handling
  - Prevent infinite redirect loop on payment failure - browser paywall now
    shows user-friendly error page instead of redirecting
  - Validate payment type before settlement to prevent charging users without
    granting rate limit tokens
  - Prevent silent success when payment settlement cannot grant tokens - now
    returns error instead of charging without providing service
  - Validate resource target format before settling payment to prevent invalid
    payment processing
  - Validate Host header presence and format before processing payments to
    prevent malformed payment requests
  - Use configured capacity multiplier instead of hardcoded value in payment
    processor for consistent multiplier application
  - Update paywall redirect URL to use new canonical path for consistency with
    updated route structure
- **Rate Limiter Configuration**: Fixed configuration handling for consistent behavior
  - Ensure consistent resource key normalization across Redis and Memory rate
    limiter implementations to prevent cache misses
  - Use configurable capacity multiplier in rate limit routes instead of
    hardcoded values for consistency with payment processor

## [Release 57] - 2025-11-03

This is a **recommended release**. This release focuses on improving gateway
infrastructure with enhanced CDN compatibility and a new gateway-based offset
discovery system. Key improvements include a new root transaction index using
HEAD requests to AR.IO gateways, configurable Cache-Control headers for better
CDN integration, and numerous bug fixes for proxy support. The release also
includes extensive documentation improvements.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **GatewaysRootTxIndex for Offset Discovery**: New root transaction index
  using HEAD requests to AR.IO gateways for discovering data item offsets
  - Multi-gateway support with priority tiers and automatic fallback (single
    attempt per gateway to prevent thundering herd)
  - Per-gateway rate limiting with TokenBucket
  - LRU caching for offset results
  - Configuration via `GATEWAYS_ROOT_TX_URLS`,
    `GATEWAYS_ROOT_TX_REQUEST_TIMEOUT_MS`,
    `GATEWAYS_ROOT_TX_RATE_LIMIT_BURST_SIZE`,
    `GATEWAYS_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL`,
    `GATEWAYS_ROOT_TX_RATE_LIMIT_INTERVAL`, `GATEWAYS_ROOT_TX_CACHE_SIZE`
- **Configurable Cache-Control Private Directive**: CDN compatibility via
  `CACHE_PRIVATE_SIZE_THRESHOLD` (default: 100 MB) and
  `CACHE_PRIVATE_CONTENT_TYPES` environment variables
  - Adds `private` directive to Cache-Control headers for content exceeding
    size threshold or matching content types
  - Ensures rate limiting and x402 payment requirements are enforced even when
    CDNs are deployed in front of ar-io-node
- **Enhanced Rate Limiting Observability**: Client IP now logged separately in
  rate limit exceeded messages for better debugging and monitoring

### Fixed

- **Proxy Support Fixes**:
  - Fixed x402 resource URLs to use `SANDBOX_PROTOCOL` when behind reverse
    proxies/CDNs
  - Fixed inconsistent IP extraction between rate limiter bucket keys and
    allowlist checks
- **Chunk Endpoint Performance**: Apply rate limits before expensive txResult
  lookup
  - Reordered operations to check rate limits first, improving performance
    under high load
- **Cache-Control Content Type Matching**: Normalize content types by stripping
  parameters (e.g., `text/html; charset=utf-8` → `text/html`)
  - Ensures proper Cache-Control header matching for configured content types

### Documentation

- Comprehensive rate limiting documentation cleanup (~200-300 lines of
  duplication removed)
- Documented all 4 rate limit metrics (request, IP, chunk, x402 token
  consumption)
- Added automated payment workflow testing examples for x402
- Removed private key export recommendations from x402 testing examples
- Clarified complete IP extraction fallback order for proxy scenarios
- Clarified Cloudflare header extraction behavior
- Removed redundant mentions of x402 requiring rate limiter

## [Release 56] - 2025-10-27

This is a recommended release due to fixes for nested bundle offset
calculations.

This release continues the x402 payment protocol expansion from Release 55,
extending payment and rate limiting support to the chunk endpoint and adding
comprehensive operator documentation. The `/ar-io/info` endpoint now exposes
rate limiter and payment configuration for programmatic gateway discovery.
This release also includes important fixes for nested bundle offset calculations
that could affect data retrieval, making it a recommended upgrade for all
operators.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Chunk Endpoint Payment and Rate Limiting**: Added x402 payment and rate
  limiting support to `GET /chunk/:offset` endpoint for gateway monetization
  and traffic control:
  - Uses fixed size assumption (~360 KiB) for predictable pricing without
    waiting for chunk retrieval
  - Configurable via `CHUNK_GET_BASE64_SIZE_BYTES` environment variable
    (default: 368,640 bytes)
  - HEAD requests consume one token (to prevent spam)
  - 304 Not Modified responses consume one token (to prevent spam)
  - Compatible with all existing x402 and rate limiter configuration
- **Configuration Validation**: Added startup validation that ensures
  `ENABLE_RATE_LIMITER=true` when `ENABLE_X_402_USDC_DATA_EGRESS=true`. The
  application will fail to start with a clear error message if x402 is enabled
  without the rate limiter, since x402 payments require rate limiting to
  function (402 responses are only sent when rate limits are exceeded)
- **Gateway Info Endpoint**: The `/ar-io/info` endpoint now exposes rate limiter
  and x402 payment configuration when these features are enabled. This allows
  clients to programmatically discover gateway capabilities, pricing, and limits.
  New optional response fields:
  - `rateLimiter` - Per-resource and per-IP bucket capacities, refill rates, and
    byte convenience fields (when `ENABLE_RATE_LIMITER=true`)
  - `x402` - Payment network, wallet address, facilitator URL, per-byte pricing
    with min/max bounds, example costs for common sizes (1KB/1MB/1GB), and
    capacity multiplier for paid tier (when `ENABLE_X_402_USDC_DATA_EGRESS=true`)
- **x402 and Rate Limiter Documentation**: Added comprehensive operator guide at
  `docs/x402-and-rate-limiting.md` covering x402 payment protocol and rate
  limiting configuration:
  - Configuration via `.env` files with detailed examples
  - Secrets management using volume mounts for Coinbase Develop Program
    credentials
  - Complete list of rate limited endpoints including `GET /chunk/:offset`
  - Token consumption patterns and pricing models for all endpoints
  - Integration with x402 facilitator services
  - Testing and troubleshooting guidance
- **Coinbase Developer Platform Environment Variables**: Added environment
  variables for Coinbase Developer Platform (CDP) integration:
  - `CDP_API_KEY_ID` - CDP API key identifier
  - `CDP_API_KEY_SECRET` - CDP API secret key
  - `CDP_API_KEY_SECRET_FILE` - Load CDP secret from file for improved security

### Changed

- **Glossary**: Added new "Rate Limiter & x402 Payment Protocol" section
  consolidating related terms:
  - Facilitator - Payment verification and settlement service
  - Rate Limiter - Traffic control system overview
  - Rate Limiter Token Types - Paid vs regular token pools
  - Token Bucket Algorithm - Rate limiting algorithm details
  - x402 Protocol - HTTP 402 payment protocol definition
- **CDP Environment Variables**: Refactored Coinbase Developer Platform API key
  configuration:
  - Removed `X_402_CDP_CLIENT_KEY_FILE` (client key is public, doesn't need
    file-based loading)
  - Split into separate `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` variables
  - Added `CDP_API_KEY_SECRET_FILE` for secure file-based loading of sensitive
    API secret

### Fixed

- **Docker Compose Configuration**: Added `ENABLE_DATA_ITEM_ROOT_TX_SEARCH` and
  `ENABLE_PASSTHROUGH_WITHOUT_OFFSETS` environment variables to
  `docker-compose.yaml`, `.env.example`, and `docs/envs.md`. These options
  control offset-aware data source behavior and were previously only defined in
  `src/config.ts`, making them unavailable for Docker Compose users to configure
  via `.env` files
- **Data Handler Rate Limiting**: Fixed rate limiting for non-indexed data by:
  - Removing `dataAttributes !== undefined` check that prevented rate limiting
    before data indexing
  - Using `data.size` (always available) as primary source for content size
    calculation with fallback to `dataAttributes?.size`
  - Aligning content size calculation with actual `Content-Length` header values
  - Ensuring consistent rate limiting across all data endpoints (raw data,
    manifest, and bundled data)
- **Nested Bundle Data Item Offset Calculation**: Fixed multiple
  offset calculation issues affecting nested bundle data item retrieval:
  - Corrected Turbo DynamoDB dataOffset to use absolute semantics (offset +
    headerSize) instead of relative semantics, ensuring consistency with bundle
    parsing and type documentation
  - Fixed rootDataItemOffset calculation to include target item's offset, not
    just parent dataOffset values
  - Fixed region boundary validation to handle offset=0 correctly (was
    incorrectly skipping validation due to truthy checks)
  - Added backward compatibility fallback for data without dataOffset attributes
- **304 Not Modified Pre-Charging**: Prevented 304 Not Modified responses from
  being pre-charged with full content size before checking If-None-Match
  headers. Now correctly predicts 304 responses and applies minimal token charge
  without denying legitimate cached requests

## [Release 55] - 2025-10-20

This is an optional release focused on x402 payment protocol improvements.

This release represents a major milestone in the gateway x402 payment protocol
implementation. The x402 capabilities have evolved from an MVP supporting only
limited data endpoints to a full, mostly feature-complete solution. The browser
paywall now uses redirect mode to properly handle content-type metadata, and
rate limiting has been extended to work correctly across all content delivery
paths including manifests, ArNS names, and range requests.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Token Consumption Metrics**: New `rate_limit_tokens_consumed_total`
  Prometheus counter for monitoring rate limiter usage with labels:
  - `bucket_type` (ip/resource) - Which bucket consumed tokens
  - `token_type` (paid/regular) - Which token pool was used
  - `domain` - Domain consuming the tokens
  - Enables monitoring and alerting on token consumption patterns
- **Environment Variables**:
  - `RATE_LIMITER_TYPE`: Configure rate limiter implementation ("memory" for
    development/testing, "redis" for production)
  - `CDP_API_KEY_SECRET_FILE`: Load CDP secret API key from file instead of
    environment variable for improved security (for Coinbase Onramp integration)
  - `RATE_LIMITER_ARNS_ALLOWLIST`: Comma-separated list of ArNS names that
    bypass rate limiting and payment verification

### Changed

- **Token Consumption Priority**: Changed token consumption order to prioritize
  regular tokens:
  - Regular tokens consumed first, then paid tokens
  - Paid tokens now act as overflow capacity instead of being consumed
    immediately
  - Paid token balance still provides bypass of per-resource rate limits
  - This change provides better value to paying users as paid tokens last
    longer
- **Rate Limiting and Payment Architecture**: Refactored internal architecture
  for improved maintainability (no operator-visible behavior changes beyond those
  listed above)

### Fixed

- **X402 Browser Paywall**: Implemented redirect mode to fix blob URL
  content-type handling issues:
  - Browser requests now receive proper redirects after payment verification
  - Resolves content-type metadata loss that occurred with blob URLs
  - Preserves original content metadata in browser delivery
- **Rate Limiting for Manifests and ArNS**: Fixed rate limits to correctly
  apply to manifest-resolved and ArNS resources:
  - Rate limits now apply after manifest resolution to actual content size
  - ArNS resources are now properly rate limited
  - Ensures consistent rate limiting across all content delivery paths
- **Range Request Token Consumption**: Fixed rate limiter to charge tokens
  based on actual bytes served in range requests instead of full content size
- **Rate Limiter Token Tracking**: Fixed internal token bucket tracking to
  properly record consumption in all edge cases
- **Token Consumption for Non-Data Responses**: Prevented token consumption for
  304 Not Modified and HEAD responses which don't transfer content data

## [Release 54] - 2025-10-13

This is a **recommended release** due to the improvements to chunk observation
and retrieval. The release enhances peer selection for chunk operations,
introduces experimental X402 payment protocol support, and enables offset
observation enforcement by default to strengthen network reliability.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **X402 Payment Protocol (Experimental)**: Optional USDC-based payment
  system for accessing rate-limited content. This feature is experimental
  and will be rapidly built out in upcoming releases.
  - Dynamic content-based pricing (default: $0.0000000001/byte = $0.10/GB)
  - USDC payments via Coinbase facilitator on Base network (mainnet and
    testnet supported)
  - Rate limiter integration with 10x capacity multiplier for paid tier
  - Proportional bucket top-off capped to actual price paid
  - HTML paywall for browser clients, JSON responses for API clients
  - Settlement timeout protection (5s default)
  - Configuration via 13 new `X_402_*` environment variables (see
    `.env.example` for details)
  - **Note**: Currently only applies to `/<id>` and `/raw/<id>` endpoints
    for non-manifests
- Expanded default preferred chunk GET node pool from 12 to 22 nodes,
  adding data-13 through data-17 (5 additional data nodes) and tip-1
  through tip-5 (5 tip nodes) for improved redundancy and load
  distribution across the Arweave network.
- Added GraphQL as third fallback option in `ROOT_TX_LOOKUP_ORDER` (after
  db and turbo) to prevent lookup failures when Turbo's circuit breaker
  is open, enabling more resilient root transaction discovery.
- Added deterministic weight-based peer selection for chunk operations
  (both GET and POST). Peers are now sorted by weight in descending order
  and top N selected, ensuring preferred peers (weight 100) are always
  tried first instead of probabilistic selection.
- Added preferred peer weight preservation for chunk operations to prevent
  weight degradation for operator-configured preferred peers during
  temporary failures. Preferred peers maintain their initial weight (100)
  regardless of success/failure, honoring operator configuration while
  allowing discovered peers to adapt based on performance.

### Changed

- **Observer**: Enabled offset observation enforcement by default.
  `OFFSET_OBSERVATION_ENFORCEMENT_ENABLED` now defaults to `true` instead
  of `false`. Gateway assessments will fail if offset validation fails,
  strengthening network reliability requirements. Operators can opt-out by
  explicitly setting `OFFSET_OBSERVATION_ENFORCEMENT_ENABLED=false`.
- Reduced logging verbosity by moving DNS resolution and sync bucket
  operational logs from debug/info to silly level. DNS resolution messages
  ('Resolving hostname', 'Resolved IPv4/IPv6 addresses') and sync bucket
  updates ('Parsed ETF sync buckets', 'Updated sync buckets') now use
  silly level, while completion and peer selection messages remain at
  debug level for visibility.

### Fixed

- Fixed preferred peer weight preservation to only apply to chunk
  operations (GET/POST) instead of all operation categories. Previously,
  preferred chunk peers maintained constant weight across chain, getChunk,
  and postChunk operations. Now preferred chunk peers can undergo normal
  warming/cooling when used for chain operations, preventing indefinite
  selection of peers that perform poorly for chain operations while still
  maintaining constant weight for chunk operations.
- Fixed ANS-104 data item header parsing for Ethereum signatures (type 3)
  by using correct 65-byte uncompressed public key length instead of
  20-byte address length. This resolves "Invalid buffer" errors when
  parsing Ethereum-signed data items. Also updated
  `MAX_DATA_ITEM_HEADER_SIZE` from 6228 to 8257 bytes to account for
  MultiAptos signature type (largest supported), and replaced custom
  signature/owner length methods with `getSignatureMeta()` from arbundles
  library for consistency.
- Fixed root TX discovery to use non-blocking rate limiting instead of
  blocking when rate limits are reached. Services now use
  `tryRemoveTokens()` and skip rate-limited gateways/sources immediately
  rather than waiting indefinitely, preventing request blocking and
  improving responsiveness. Also fixed GraphQL service to return
  `dataSize` instead of incorrect `size` field.

### Known Issues

- The x402 browser paywall currently uses blob URLs for content delivery
  after successful payment. This causes issues with content-type handling
  and browser behavior as the blob URL doesn't preserve the original
  content metadata. **We plan to fix this in upcoming releases** by
  either contributing to the x402 SDK to add a page reload option, or
  implementing a custom paywall template that properly handles redirects
  after payment verification.

## [Release 53] - 2025-10-06

This is an optional release that introduces root transaction offset tracking
for nested bundles and observer performance improvements. The release enables
more efficient data retrieval through comprehensive offset tracking with Turbo
and GraphQL integration, while improving observer reliability with increased
chunk validation success rates.

### Added

- **Root Transaction and Offset Tracking**: Comprehensive offset tracking
  system for nested ANS-104 bundles:
  - Turbo `/offsets` endpoint integration for accurate root transaction
    discovery and offset calculations
  - Handles multi-level nested bundles with cumulative offset tracking
  - Cycle detection and maximum nesting depth protection (10 levels)
  - Database persistence of root transaction IDs and absolute offset values
- **GraphQL Root TX Index**: Dedicated GraphQL endpoint configuration for root
  transaction lookups:
  - `GRAPHQL_ROOT_TX_GATEWAYS_URLS`: JSON object mapping GraphQL endpoints to
    weights (default: `{"https://arweave-search.goldsky.com/graphql": 1}`)
  - Parent chain traversal with metadata extraction (content type, size)
  - Fallback mechanism when Turbo is unavailable
  - Configurable lookup order via `ROOT_TX_LOOKUP_ORDER` (default: "db,turbo")
- **Database Migration**: Added offset tracking columns to
  `contiguous_data_ids` table:
  - `root_transaction_id`: Top-level Arweave transaction containing the data
  - `root_data_item_offset`: Absolute position where data item headers begin in
    root bundle
  - `root_data_offset`: Absolute position where data payload begins in root
    bundle
- **HTTP Headers**: New headers exposing absolute root offset information:
  - `X-AR-IO-Root-Data-Item-Offset`: Enables direct byte-range requests to data
    item headers
  - `X-AR-IO-Root-Data-Offset`: Enables direct byte-range requests to data
    payloads
- **Outbound Rate Limiting for External APIs**: Token bucket rate limiting for
  outbound calls to Turbo and GraphQL services (separate from the Redis-based
  inbound rate limiter added in Release 52):
  - Turbo API: Configurable via `TURBO_ROOT_TX_RATE_LIMIT_BURST_SIZE` (default: 5),
    `TURBO_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL` (default: 6),
    `TURBO_ROOT_TX_RATE_LIMIT_INTERVAL` (default: "minute")
  - GraphQL API: Configurable via `GRAPHQL_ROOT_TX_RATE_LIMIT_BURST_SIZE` (default: 5),
    `GRAPHQL_ROOT_TX_RATE_LIMIT_TOKENS_PER_INTERVAL` (default: 6),
    `GRAPHQL_ROOT_TX_RATE_LIMIT_INTERVAL` (default: "minute")
  - Prevents excessive API usage and respects external service limits (defaults
    to 6 requests per minute = 1 per 10 seconds)
- **Configuration Options**:
  - `ENABLE_DATA_ITEM_ROOT_TX_SEARCH`: Enable/disable root transaction search
    for data items in offset-aware sources (default: true)
  - `ENABLE_PASSTHROUGH_WITHOUT_OFFSETS`: Control whether offset-aware sources
    allow data retrieval without offset information (default: true)
  - Dedicated rate limiting configuration for Turbo and GraphQL root TX lookups
  - Separate GraphQL gateway configuration for root lookups vs data retrieval
- **Documentation and Testing**:
  - Comprehensive bundle offsets documentation in
    `docs/drafts/bundle-offsets.md`
  - Rate limiting behavior tests validating token accumulation and request
    delays
  - Enhanced test coverage for offset tracking and nested bundle scenarios

### Changed

- **Observer**: Increased `OFFSET_SAMPLE_COUNT` default from 3 to 4 to improve
  chunk validation success rate with early stopping
- Increased rate limiter defaults to accommodate larger response payloads:
  - `RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET`: 10,000 → 1,000,000 tokens (~10 MiB → ~976 MiB bucket capacity)
  - `RATE_LIMITER_IP_TOKENS_PER_BUCKET`: 2,000 → 100,000 tokens (~2 MiB → ~98 MiB bucket capacity)
  - Resource refill rate remains 100 tokens/second (~98 KiB/s)
  - IP refill rate remains 20 tokens/second (~20 KiB/s)
  - Note: 1 token = 1 KiB (where 1 KiB = 1,024 bytes) of response data, minimum 1 token per request
  - Rate limiter remains disabled by default (`ENABLE_RATE_LIMITER=false`)
- **Performance Optimization**: RootParentDataSource now uses pre-computed root
  offsets when available:
  - Skip bundle traversal entirely when offsets are cached in database
  - Direct offset-based data retrieval without parent chain traversal
  - Use `rootDataOffset` to skip headers when fetching data payloads
  - Significantly reduces latency for nested bundle data retrieval

### Fixed

- **Security**: Resolved transitive dependency vulnerabilities by adding yarn
  resolutions:
  - `ws@7.5.10`: Fixed DoS vulnerability when handling requests with many HTTP
    headers (CVE in ws <7.5.10)
  - `semver@7.6.3`: Fixed Regular Expression Denial of Service (ReDoS)
    vulnerability (CVE in semver <7.5.2)

## [Release 52] - 2025-09-29

This is a **recommended release** that introduces critical observer reliability
improvements and a new Redis-based rate limiting system. The release significantly
improves observer stability under load through reduced sample rates, optimized
timeouts, and better concurrency management. Additionally, it introduces a complete
rate limiting solution with token bucket algorithm and IP allowlist support for
enhanced DDoS protection.

> **⚠️ EXPERIMENTAL FEATURES**: The rate limiter and x402 payment protocol are
> experimental features subject to change. API endpoints, parameters, behavior,
> and configuration options (environment variables) may evolve in future
> releases as these systems continue to be developed. See
> [docs/x402-and-rate-limiting.md](docs/x402-and-rate-limiting.md) for
> comprehensive documentation.

### Added

- **Rate Limiter**: Complete Redis/Valkey-based rate limiting system with:
  - Token bucket algorithm with configurable limits per IP and resource
  - IP allowlist support with CIDR block matching
  - Lua scripts for atomic Redis operations
  - Support for both cluster and non-cluster Redis deployments
  - Configuration via environment variables:
    - `ENABLE_RATE_LIMITER`: Enable/disable rate limiting (default: false)
    - `RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET`: Resource token bucket size
      (default: 10000)
    - `RATE_LIMITER_RESOURCE_REFILL_PER_SEC`: Resource token refill rate
      (default: 100)
    - `RATE_LIMITER_IP_TOKENS_PER_BUCKET`: IP token bucket size (default: 2000)
    - `RATE_LIMITER_IP_REFILL_PER_SEC`: IP token refill rate (default: 20)
    - `RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST`: Comma-separated allowlist of
      IPs/CIDRs
    - `RATE_LIMITER_REDIS_ENDPOINT`: Redis endpoint (default: localhost:6379)
    - `RATE_LIMITER_REDIS_USE_TLS`: Enable TLS for Redis (default: false)
    - `RATE_LIMITER_REDIS_USE_CLUSTER`: Use Redis cluster mode (default: false)
- **Chunk Offset Concurrency Control**: Added
  `CHUNK_OFFSET_CHAIN_FALLBACK_CONCURRENCY` config (default: 5) to limit
  concurrent fallback requests to the Arweave network, preventing resource
  exhaustion under high load
- **Observer Metrics**: Added comprehensive Prometheus metrics for observer
  performance including:
  - Ownership, ArNS name, and offset assessment metrics with pass/fail tracking
  - Report generation timing and success/failure counters
  - Gateway assessment overall status tracking
  - AR.IO node release version as global label on all metrics
  - `/ar-io/observer/metrics` endpoint for Prometheus scraping

### Changed

- **Security Updates**: Updated dependencies to address security
  vulnerabilities:
  - @ar.io/sdk to 3.20.0
  - @dha-team/arbundles to 1.0.4
  - axios to 1.12.0
  - Multiple other minor/patch updates for security fixes
- **Observer Performance Improvements**:
  - Reduced default offset observation sample rate from 5% to 1% to minimize
    observation failures under load
  - Added quick chunk validation to skip expensive binary search operations
  - Reduced concurrent connections and serialized ownership checks for better
    reliability
  - Optimized timeout configurations (7 seconds) for more reliable assessments

### Fixed

- **GraphQL Pagination**: Corrected transaction ID sorting to match ClickHouse
  binary ordering, eliminating duplicate transactions across consecutive query
  pages
- **Security Vulnerabilities**:
  - Resolved critical elliptic ECDSA private key extraction vulnerability
  - Resolved secp256k1 ECDH private key extraction vulnerability
- **Metrics**: Only increment `requestChunkTotal` counter for actual chunk
  requests
- **API Response**: Replaced `syncBuckets` with `bucketCount` in `/ar-io/peers`
  response

## [Release 51] - 2025-09-22

This is a **recommended release** that introduces significant enhancements to
metrics, observer capabilities, gateway filtering, and performance. The release
includes metrics improvements with release tracking, major observer enhancements
with offset observation capabilities, enhanced trusted gateway filtering to
prevent caching issues, and optimized chunk retrieval performance.

### Added

- **Metrics Enhancement**: Added release number as default label to all
  Prometheus metrics, enabling filtering and comparison across releases
- **Enhanced Data Stream Metrics**: Added comprehensive byte tracking with
  `getDataStreamBytesTotal` counter and `getDataStreamSizeHistogram` with 4
  buckets (100KB, 1MB, 10MB, 100MB)
- **Peer Metrics**: Added metrics for preferred peers and peer types, tracking
  "preferred" vs regular "peer" sources and "bucket" vs "general" peer selection
- **Observer Offset Observation**: Added complete V1 implementation of offset
  observation with cryptographic chunk validation using arweave.js validatePath()
  for enhanced data integrity verification. This feature is currently in testing
  phase and will be gradually enabled across the network
- **Observer Gateway Sampling**: Added configurable gateway sampling for offset
  observations with `OFFSET_OBSERVATION_SAMPLE_RATE` (default 5%)
- **Observer Reference Gateway Comparison**: Added chunk availability comparison
  against reference gateway to identify gateway-specific vs network-wide issues
- **Observer Configuration Controls**: Added `OFFSET_OBSERVATION_ENFORCEMENT_ENABLED`
  to control whether offset failures cause gateway assessment failures (default: false)
- **Trusted Gateway Filtering**: Added comprehensive IP and origin filtering for
  trusted gateways with support for CIDR blocks and X-Real-IP header to prevent
  gateway loops and unexpected caching behavior
- **Chunk Offset Sampling Tool**: Added gateway health monitoring tool for chunk
  offset sampling (see `tools/sample-chunk-offsets`)
- **Storage Partition Converter**: Added Arweave storage partition to height
  range converter script (see `tools/arweave-partitions-to-heights`)

### Changed

- **Request Type Labels**: Simplified metric request_type labels to 'full'
  (complete data) and 'range' (partial data) for consistency
- **Peer Management**: Refactored peer management architecture with extracted
  ArweavePeerManager from ArweaveCompositeClient
- **Cache Management**: Improved cache handling with proper timer cleanup in
  NodeCache
- **Chunk Retrieval Optimization**: Optimized chunk retrieval to use single
  peer selection per request, reducing overhead
- **Offset-Aware Architecture**: Implemented TxOffsetSource architecture for
  more efficient chunk retrieval with sync bucket support

### Fixed

- **Root Transaction Detection**:
  - Enhanced logic to prevent incorrect root detection for self-referencing
    transactions
  - Added early exit for self-referencing root transactions
- **Data Cache**: Fixed data cache to respect SKIP_DATA_CACHE setting and skip
  writes when disabled

## [Release 50] - 2025-09-15

This is a **recommended release** due to cache safety improvements that prevent
caching incomplete data and enhance data validation reliability.

This release introduces significant robustness improvements with offset-aware
data sources, experimental datasets HTTP endpoint for analytics workloads, and
enhanced Parquet/Iceberg tooling. It also includes important fixes for data
validation and root parent traversal.

### Added

- **Offset-Aware Data Sources**: Added two new offset-aware data sources that
  leverage cached upstream offset attributes for improved performance:
  - `chunks-offset-aware` (renamed from `chunks-data-item` with backwards
    compatibility) - enables automatic data item resolution within ANS-104
    bundles using cached offsets
  - `trusted-gateways-offset-aware` - uses cached upstream offsets without
    expensive searching for faster data retrieval
- **Cache Skip Configuration**: Added `SKIP_DATA_CACHE` environment variable to
  bypass cache retrieval and always fetch from upstream sources for testing and
  debugging
- **Datasets HTTP Endpoint (Experimental)**: Added optional `/local/datasets`
  endpoint (disabled by default) for HTTP access to Parquet files and Iceberg
  metadata, enabling remote DuckDB queries. Note: This feature is experimental
  and subject to change
- **Datasets Proxy Configuration**: Added configurable datasets proxy via Envoy
  with `DATASETS_PROXY_HOST` and `DATASETS_PROXY_PORT` environment variables
- **Parquet Repartitioning Tool**: Added comprehensive `parquet-repartition`
  script supporting both tag-based and owner address-based partitioning with
  height chunking and Iceberg metadata generation
- **Minimal Iceberg Metadata Generator**: Added lightweight
  `generate-minimal-iceberg-metadata` script optimized for DuckDB compatibility
  with HTTP URL support
- **Multi-Architecture Support**: Added multi-arch support to ClickHouse
  auto-import Docker image for broader platform compatibility

### Changed

- **Default Retrieval Order**: Updated default `ON_DEMAND_RETRIEVAL_ORDER` to
  use new `chunks-offset-aware` name (backwards compatible with
  `chunks-data-item`)
- **Iceberg Metadata Implementation**: Replaced complex PyIceberg-based
  implementation with minimal fastavro-based version for better performance and
  DuckDB compatibility
- **Zero-Size Data Handling**: Skip caching and indexing for zero-size data to
  prevent unnecessary storage operations

### Fixed

- **Root Parent Traversal**: Fixed RootParentDataSource to properly handle root
  transactions without cached attributes
- **Data Size Validation**: Added validation to prevent caching incomplete data
  and prevent ID to hash mapping queue on partial stream errors
- **Parquet Export Issues**: Fixed CSV column type specification to prevent
  DuckDB type inference errors
- **ClickHouse Build Workflow**: Updated build workflow to include missing file
  paths

## [Release 49] - 2025-09-07

This is an optional release that significantly improves the ClickHouse ETL pipeline with better performance, reliability, and Apache Iceberg metadata support. While optional for most users, this release is important for anyone experimenting with Parquet exports and ClickHouse integration.

### Added

- **Apache Iceberg Metadata Generation**: Added `generate-iceberg-metadata`
  script to create Apache Iceberg table metadata for exported Parquet datasets,
  enabling compatibility with query engines like DuckDB and Spark. Controlled by
  new `ENABLE_ICEBERG_GENERATION` environment variable (default: false).
  **Note: Iceberg metadata generation is still under active development and
  currently incomplete.**

- **HyperBEAM Sidecar Support**: Added optional HyperBEAM container
  configuration with `.env.hb.example` template for running AO processes
  alongside the gateway.

- **ETL Configuration Documentation**: Documented existing ClickHouse
  auto-import environment variables in `.env.example`:
  - `CLICKHOUSE_AUTO_IMPORT_SLEEP_INTERVAL` - interval between import cycles
    (default: 3600 seconds)
  - `CLICKHOUSE_AUTO_IMPORT_HEIGHT_INTERVAL` - batch size in blocks (default:
    10000)
  - `CLICKHOUSE_AUTO_IMPORT_MAX_ROWS_PER_FILE` - Parquet file size limit
    (default: 1000000)

### Changed

- **ETL Pipeline Architecture**: Refactored the ClickHouse ETL pipeline for
  improved reliability and modularity:
  - Implemented staging-based workflow to prevent data corruption
  - Changed from API-based triggering to direct script execution
  - Made L1 transaction export the default behavior
  - Changed default export location from `data/parquet` to
    `data/datasets/default`
  - **Performance**: Greatly improved query performance through better index
    usage in the refactored pipeline
  - **Stability**: Fixed issue where the 'core' service would occasionally
    crash due to long-running SQLite queries

## [Release 48] - 2025-09-02

This is an optional release that introduces Turbo root transaction ID lookups,
DNS resolution for preferred chunk nodes, and automatic data item resolution
from chunks. These features continue the network's journey toward complete
independence from legacy infrastructure while improving retrieval performance
and reliability.

### Added

- Added Turbo root transaction ID source with configurable lookup order and
  circuit breakers (configurable via `ROOT_TX_INDEX_` environment variables),
  enabling efficient data item to root transaction resolution via Turbo's
  API with automatic failover handling.
- Added `chunks-data-item` data source option for retrieval orders that enables
  automatic data item resolution within ANS-104 bundles. When used in
  `ON_DEMAND_RETRIEVAL_ORDER` or `BACKGROUND_RETRIEVAL_ORDER`, this source
  transparently resolves data items to their root transactions and calculates
  correct byte ranges, allowing direct retrieval of data items from chunks
  without requiring separate data item indexing.
- Added DNS resolution for preferred chunk GET and POST nodes with automatic
  failover, enabling dynamic resolution of node hostnames to IP addresses with
  configurable refresh intervals.
- Added `X-AR-IO-Node-Release` header to all outbound HTTP requests for better
  network observability and version tracking.

### Changed

- Updated default `ON_DEMAND_RETRIEVAL_ORDER` from
  `trusted-gateways,chunks,tx-data,ar-io-network` to
  `trusted-gateways,ar-io-network,chunks-data-item,tx-data`, removing the
  deprecated `chunks` source and prioritizing AR.IO network retrieval.

## [Release 47] - 2025-08-25

This is an optional release that lays the groundwork for the gateway network to
become completely independent of the legacy arweave.net gateway by enabling
data item retrieval directly from chunks using root transaction ID lookups. It
also introduces comprehensive distributed tracing for improved observability.

### Added

- Added comprehensive OpenTelemetry distributed tracing with proper span linking
  across all data request operations, providing end-to-end visibility from HTTP
  requests through data source failovers, cache operations, and peer retrievals
  with hierarchical parent-child span relationships.
- Added `RootParentDataSource` and `Ans104OffsetSource` to enable retrieving
  data items by ID directly from chunks when only the root transaction ID is
  indexed, transparently resolving data items to their root transactions and
  calculating correct byte ranges within ANS-104 bundles (temporarily disabled
  pending additional offset sources).

### Changed

### Fixed

- Removed incorrect `Content-Digest` header from chunk endpoint which was
  misleadingly representing only chunk data hash instead of complete JSON
  response body hash (will be reintroduced with correct semantics).

## [Release 46] - 2025-08-18

This is a recommended release that introduces AR.IO network chunk retrieval with
cryptographic validation and enhanced observability. Gateway operators can now
retrieve chunks directly from AR.IO peers with the same security guarantees as
Arweave network chunks, significantly improving chunk caching and retrieval
performance.

### Added

- Added AR.IO network chunk source enabling chunk retrieval from AR.IO peers
  with weighted peer selection, retry logic, and cryptographic validation to
  prevent serving of corrupted or malicious data.
- Added comprehensive OpenTelemetry tracing for chunk retrieval operations
  providing visibility into performance, cache behavior, and source attribution
  across the entire pipeline.
- Added HEAD request support to `/chunk/{offset}` endpoint with ETag headers
  for efficient caching and conditional request handling with If-None-Match
  support.
- Added chunk source headers for traceability: `X-AR-IO-Chunk-Source-Type`
  indicating data source, `X-AR-IO-Chunk-Host` with peer hostname, and
  `X-Cache` for cache status.
- Added RFC 9530 `Content-Digest` header support for standard-compliant content
  integrity verification in data and chunk responses.
- Added configurable composite chunk sources with parallelism control via
  `CHUNK_DATA_RETRIEVAL_ORDER` and `CHUNK_METADATA_RETRIEVAL_ORDER` environment
  variables supporting comma-separated source ordering.
- Added OpenAPI documentation for `/ar-io/peers` endpoint.

### Changed

- Renamed `ar-io-peers` to `ar-io-network` as the preferred configuration name
  while maintaining backwards compatibility.
- Enhanced `/ar-io/peers` endpoint to include both data and chunk weights for
  AR.IO gateway peers.

### Fixed

- Fixed ArNS custom 404 pages to prevent incorrect ArNS headers from being
  propagated to other gateways.

## [Release 45] - 2025-08-11

This is an optional release that enhances chunk broadcasting with improved preferred
peer management, adds a hash-based partitioning filter for distributed data processing,
fixes ArNS basename cache refresh issues, and includes comprehensive documentation
improvements with a new glossary of AR.IO Node terminology.

### Added

- Added hash partitioning filter (`MatchHashPartition`) for distributing
  transaction and data item processing across multiple nodes with configurable
  partition ranges.
- Added comprehensive glossary documentation covering AR.IO Node terminology,
  concepts, and architectural components.

### Changed

- Improved chunk broadcasting preferred peer management with doubled default
  per-node queue depth threshold and ensured preferred peers are always
  prioritized first.
- Enhanced circuit breaker metrics with more detailed labels for better
  monitoring of data source failures.
- Improved ArNS resolution to properly propagate 404 errors from trusted
  gateway resolution (a more complete fix is coming in the next release).
- Expanded OTEL tracing to include ArNS cache operations for improved
  observability of name resolution and cache hydration.

### Fixed

- Fixed unreliable ArNS basename cache refreshes by adding retry logic for
  pagination failures and replacing p-debounce with timestamp-based debouncing
  for more predictable behavior.
- Fixed undefined headers handling in data requests.
- Fixed invalid cache hits by ensuring base64url encoded IDs are properly
  validated before use.
- Fixed routes data handling for undefined IDs in validity checks.

## [Release 44] - 2025-07-28

This is a recommended release that introduces efficient range request support
for contiguous data retrieval from chunks, adds bundle metadata columns with
offset indexing to improve offset availability throughout the network, enhances
Merkle path parsing compatibility, and includes comprehensive documentation for
offsets and Merkle paths.

### Added

- Added efficient range request support for chunk data retrieval, enabling
  optimized verifiable contiguous data fetching directly from Arweave nodes.
- Added bundle metadata columns to `data.db` to improve offset availability
  across the gateway network.
- Added OTEL (OpenTelemetry) tracing support for chunk POST operations,
  providing better observability for chunk broadcasting performance.
- Added OTEL environment variables to `docker-compose.yaml` for easier
  configuration of distributed tracing.
- Added comprehensive Arweave Merkle tree structure documentation detailing
  the data organization and validation rules.
- Added detailed documentation explaining Arweave transaction and chunk offset
  calculations.
- Added merkle-path-parser with full Arweave compatibility for improved
  Merkle proof validation.

### Changed

- Implemented promise-based chunk caching system replacing the previous WeakMap
  implementation, improving memory efficiency and cache reliability.
- Extended CompositeChunkSource to implement all chunk interfaces, providing
  a more unified chunk data access layer.

## [Release 43] - 2025-07-21

This is a recommended release that enables data verification by default for data
items linked to ArNS names, improves chunk broadcasting efficiency, and adds
automatic chunk data cache cleanup.

### Added

- Added automatic chunk data cache cleanup functionality with configurable
  retention period. Chunks are now automatically removed after 4 hours by default
  (configurable via `CHUNK_DATA_CACHE_CLEANUP_THRESHOLD`). The cleanup can be
  disabled by setting `ENABLE_CHUNK_DATA_CACHE_CLEANUP=false`. This helps manage
  disk space usage while maintaining cache performance benefits.
- Added demand-driven opt-out background verification for ArNS data. When ArNS
  names are requested, the system now proactively verifies the underlying data
  asynchronously in the background by unbundling verified chunk data retrieved
  directly from Arweave nodes. This ensures ArNS-served content is prioritized
  for verification, improving data integrity guarantees for frequently accessed
  named content.

### Changed

- Simplified chunk data storage by removing the dual-storage approach (by-hash
  and by-dataroot with symlinks). Chunks are now stored directly by data root
  only, reducing complexity and improving performance.
- Revamped chunk broadcasting architecture from 3-tier system to unified
  peer-based approach. Chunk broadcasting now uses individual fastq queues per
  peer with configurable concurrency and queue depth protection. Added support
  for preferred chunk POST peers via `PREFERRED_CHUNK_POST_URLS` environment
  variable. Configuration defaults have been optimized:
  `CHUNK_POST_PEER_CONCURRENCY` now defaults to match
  `CHUNK_POST_MIN_SUCCESS_COUNT` (3) to avoid over-broadcasting, and
  `CHUNK_POST_PER_NODE_CONCURRENCY` defaults to match
  `CHUNK_POST_QUEUE_DEPTH_THRESHOLD` (10) for consistent per-node load
  management. This change improves broadcast reliability and performance while
  simplifying the codebase by removing circuit breakers and tier-based logic.
- Modified `DataVerificationWorker` to ensure data item IDs (not just root IDs)
  have their retry count incremented, preventing IDs from being stuck without
  retry attempts. This improves the reliability of the data verification
  process.

### Fixed

- Fixed experiment bash Parquet export script generating filenames with
  `count_star()` instead of actual row counts for blocks and tags files. The
  script now correctly uses the `-noheader` flag when retrieving counts for
  filename generation.
- Fixed missing directory existence checks in FsCleanupWorker to prevent errors
  when attempting to scan non-existent directories during filesystem cleanup
  operations.

## [Release 42] - 2025-07-14

This is an optional release that improves peer request traceability, adds
HyperBEAM URL support, and includes draft AI-generated technical documentation.

### Added

- Added support for optional HyperBEAM URL configuration via
  `AO_ANT_HYPERBEAM_URL` environment variable. In the future this allows ANT
  processes to use HyperBEAM nodes for caching and serving state, reducing
  pressure on compute units for simple read requests.
- Added AI-generated technical documentation covering AR.IO gateway
  architecture, data retrieval, Arweave connectivity, ArNS name resolution
  system, centralization analysis, and database architecture. These guides in
  `docs/drafts/` are generally correct but should not be considered
  authoritative.
- Added origin and release information to query string parameters in outbound
  requests to both peer gateways and trusted gateways. Data requests now
  include `ar-io-hops`, `ar-io-origin`, `ar-io-origin-release`,
  `ar-io-arns-record`, and `ar-io-arns-basename` as query parameters,
  improving network observability and request tracing across the entire
  gateway network.

### Changed

- Implemented X-AR-IO header initialization for outbound peer requests while
  removing `x-ar-io-origin` and `x-ar-io-origin-node-release` headers from
  responses. This change maintains necessary header functionality for peer
  communication while reducing unnecessary header overhead in responses.
- Updated `@ar.io/sdk` dependency to support optional HyperBEAM URL
  functionality.

## [Release 41] - 2025-06-30

Upgrading to this release is recommended but not urgent due to improvements in
peer data fetching safety.

### Added

- Added preferred chunk GET node URLs configuration via
  `PREFERRED_CHUNK_GET_NODE_URLS` environment variable to enable chunk-specific
  peer prioritization. Preferred URLs receive a weight of 100 for
  prioritization and the system selects 10 peers per attempt by default.
- Added hash validation for peer data fetching by including
  `X-AR-IO-Expected-Digest` header in peer requests when hash is available,
  validating peer responses against expected hash, and immediately rejecting
  mismatched data.
- Added `DOCKER_NETWORK_NAME` environment variable to configure the Docker
  network name used by Docker Compose.
- Added draft guide for running a community gateway.
- Added draft data verification architecture document.

### Changed

- Removed trusted node fallback for chunk retrieval. Chunks are now retrieved
  exclusively from peers, with the retry count increased from 3 to 50 to ensure
  reliability without the trusted node fallback.

### Fixed

- Fixed inverted logic preventing symlink creation in `FsChunkDataStore`.
- Fixed `Content-Length` header for range requests and 304 responses, properly
  setting header for single and multipart range requests and removing entity
  headers from 304 Not Modified responses per RFC 7232.
- Fixed `MaxListenersExceeded` warnings by adding `setMaxListeners` to
  read-through data cache.
- Fixed potential memory leaks in read-through data cache by using `once`
  instead of `on` for `error` and `end` event listeners.

## [Release 40] - 2025-06-23

This is an optional release that primarily improves caching when data is
fetched from peers.

### Added

- Added experimental `flush-to-stable` script for manual database maintenance.
  This script allows operators to manually flush stable chain and data item
  tables, mirroring the logic of
  `StandaloneSqliteDatabase.flushStableDataItems`.
  **WARNING: This script is experimental and directly modifies database contents.
  Use with caution and ensure proper backups before running.**

### Changed

- Replaced yesql with custom SQL loader that handles comments better, improving
  SQL file parsing and maintenance.
- Switched to SPDX license headers to reduce LLM token usage, making the
  codebase more efficient for AI-assisted development.
- Improved untrusted data handling and hash validation in cache operations. The
  cache now allows caching when a hash is available for validation even for
  untrusted data sources, but only finalizes the cache when the computed hash
  matches a known trusted hash. This prevents cache poisoning while still
  allowing data caching from untrusted sources when the data can be validated.

## [Release 39] - 2025-06-17

This release enhances observability and reliability with new cache metrics,
improved data verification capabilities, and automatic failover between chain
data sources. The addition of ArNS-aware headers enables better data
prioritization across the gateway network. This is a recommended but not urgent
upgrade.

### Added

- Added filesystem cache metrics with cycle-based tracking. Two new Prometheus
  metrics track cache utilization: `cache_objects_total` (number of objects in
  cache) and `cache_size_bytes` (total cache size in bytes). Both metrics include
  `store_type` and `data_type` labels to differentiate between cache types (e.g.,
  headers, contiguous_data). Metrics are updated after each complete cache scan
  cycle, providing accurate visibility into filesystem cache usage.
- Added `X-AR-IO-Data-Id` header to all data responses. This header shows the
  actual data ID being served, whether from a direct ID request or manifest path
  resolution, providing transparency about the content being delivered.
- Added automatic data item indexing when data verification is enabled. When
  `ENABLE_BACKGROUND_DATA_VERIFICATION` is set to true, the system now
  automatically enables data item indexing (`ANS104_UNBUNDLE_FILTER`) with an
  `always: true` filter if no filter is explicitly configured. This ensures
  bundles are unbundled to verify that data items are actually contained in
  the bundle associated with the Arweave transaction's data root.
- Added ArNS headers to outbound gateway requests to enable data prioritization.
  The `generateRequestAttributes` function now includes ArNS context headers
  (`X-ArNS-Name`, `X-ArNS-Basename`, `X-ArNS-Record`) in requests to other
  gateways and Arweave nodes, allowing downstream gateways to effectively
  prioritize ArNS data requests.
- Added configurable Docker Compose host port environment variables
  (`CORE_PORT`, `ENVOY_PORT`, `CLICKHOUSE_PORT`, `CLICKHOUSE_PORT_2`,
  `CLICKHOUSE_PORT_3`, `OBSERVER_PORT`) to allow flexible port mapping while
  maintaining container-internal port compatibility and security.
- Added Envoy aggregate cluster configuration for automatic failover between
  primary and fallback chain data sources. The primary cluster (default:
  arweave.net:443) uses passive outlier detection while the fallback cluster
  (default: peers.arweave.xyz:1984) uses active health checks. This enables
  zero-downtime failover between HTTPS and HTTP endpoints with configurable
  `FALLBACK_NODE_HOST` and `FALLBACK_NODE_PORT` environment variables.

### Changed

- Streamlined background data retrieval to reduce reliance on centralized sources.
  The default `BACKGROUND_RETRIEVAL_ORDER` now only includes `chunks,s3`, removing
  `trusted-gateways` and `tx-data` from the default configuration. This prioritizes
  verifiable chunk data and S3 storage for background operations like unbundling.
- Removed ar-io.net from default trusted gateways list and removed
  TRUSTED_GATEWAY_URL default value to reduce load on ar-io.net now that P2P data
  retrieval is re-enabled. Existing deployments with TRUSTED_GATEWAY_URL
  explicitly set will continue to work for backwards compatibility.

## [Release 38] - 2025-06-09

This release focuses on data integrity and security improvements, introducing
trusted data verification and enhanced header information for data requests.
Upgrading to this release is recommended but not urgent.

### Added

- Added `X-AR-IO-Trusted` header to indicate data source trustworthiness in
  responses. This header helps clients understand whether data comes from a
  trusted source and works alongside the existing `X-AR-IO-Verified` header to
  provide data integrity information. The system now filters peer data by
  requiring peers to indicate their content is either verified or trusted,
  protecting against misconfigured peers that may inadvertently serve
  unintended content (e.g., provider default landing pages) instead of actual
  Arweave data.
- Added If-None-Match header support for HTTP conditional requests enabling
  better client-side caching efficiency. When clients send an If-None-Match
  header that matches the ETag, the gateway returns a 304 Not Modified response
  with an empty body, reducing bandwidth usage and improving performance.
- Added digest and hash headers for data HEAD requests to enable client-side
  data integrity verification.
- Added EC2 IMDS (instance-profile) credential support for S3 data access,
  improving AWS authentication in cloud environments.
- Added trusted data flag to prevent caching of data from untrusted sources,
  ensuring only verified and reliable content is stored locally while still
  allowing serving of untrusted data when necessary.

### Changed

- Re-enabled ar-io-peers as fallback data source in configuration for improved
  data availability.
- Updated trusted node configuration to use arweave.net as the default trusted
  node URL.
- Updated ETag header format to use properly quoted strings (e.g., `"hash"`
  instead of `hash`) following HTTP/1.1 specification standards for improved
  compatibility with caching proxies and clients.

## [Release 37] - 2025-06-03

This is a _recommended release_ due to the included observer robustness
improvements. It also adds an important new feature - data verification for
preferred ArNS names. When preferred ArNS names are set, the bundles containing
the data they point to will be locally unbundled (verifying data item
signatures), and the data root for the bundle will be compared to the data root
in the Arweave chain (establishing that the data is on Arweave). To enable this
feature, set your preferred ArNS names, turn on unbundling by setting
`ANS104_DOWNLOAD_WORKERS` and `ANS104_UNBUNDLE_WORKERS` both to 1, and set your
`ANS104_INDEX_FILTER` to a filter that will match the data items for your
preferred names. If you don't know the filter, use `{"always": true}`, but be
aware this will index the entire bundle for the IDs related to your preferred
names.

Note: this release contains migrations to `data.db`. If your node appears
unresponsive please check `core` service logs to determine whether migrations
are running and wait for them to finish.

### Added

- Added prioritized data verification system for preferred ArNS names,
  focusing computational resources on high-priority content while enabling
  flexible root transaction discovery through GraphQL fallback support.
- Added verification retry prioritization system with tracking of retry counts,
  priority levels, and attempt timestamps to ensure bundles do not get stuck
  retrying forever.
- Added improved observer functionality with best-of-2 observations and higher
  compression for more reliable network monitoring.
- Added `MAX_VERIFICATION_RETRIES` environment variable (default: 5) to limit
  verification retry attempts and prevent infinite loops for consistently
  failing data items.
- Added retry logic with exponential backoff for GraphQL queries to handle rate
  limiting (429) and server errors with improved resilience when querying
  trusted gateways for root bundle IDs.

### Changed

- Updated dependencies: replaced deprecated express-prometheus-middleware with
  the actively maintained express-prom-bundle library and updated prom-client
  to v15.1.3 for better compatibility and security.
- Updated Linux setup documentation to use modern package installation methods,
  replacing apt-key yarn installation with npm global install and updating
  Node.js/nvm versions.
- Improved route metrics normalization with explicit whitelist function for
  better granularity and proper handling of dynamic segments.

### Fixed

- Fixed docker-compose configuration to use correct NODE_MAX_OLD_SPACE_SIZE
  environment variable name.
- Fixed production TypeScript build configuration to exclude correct "test"
  directory path.
- Fixed Parquet exporter to properly handle data item block_transaction_index
  exports, preventing NULL value issues.
- Fixed bundles system to copy root_parent_offset when flushing data items to
  maintain data integrity.
- Fixed ClickHouse auto-import script to handle Parquet export not_started
  status properly.
- Fixed docker-compose ClickHouse configuration to not pass conflicting
  PARQUET_PATH environment variable to container scripts.
- Fixed verification process for data items that have not been unbundled by
  adding queue bundle support and removing bundle join constraint to ensure
  proper verification of data items without indexed root parents.

## [Release 36] - 2025-05-27

This is a recommended but not essential upgrade. The most important changes are
the preferred ArNS caching feature for improved performance on frequently
accessed content and the observer's 80% failure threshold to prevent invalid
reports during network issues.

### Added

- Added preferred ArNS caching functionality that allows configuring lists of
  ArNS names to be cached longer via `PREFERRED_ARNS_NAMES` and
  `PREFERRED_ARNS_BASE_NAMES` environment variables. When configured, these names
  will be cleaned from the filesystem cache after
  `PREFERRED_ARNS_CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD` instead of the
  standard cleanup threshold (`CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD`). This
  is accomplished by maintaining an MRU (Most Recently Used) list of ArNS names
  in the contiguous metadata cache. When filesystem cleanup runs, it checks
  this list to determine which cleanup threshold to apply. This feature enables
  gateway operators to ensure popular or important ArNS names remain cached
  longer, improving performance for frequently accessed content.
- Added ArNS headers to responses: `X-ArNS-Name`, `X-ArNS-Basename`, and
  `X-ArNS-Record` to help identify which ArNS names were used in the resolution.

### Changed

- Updated observer to prevent report submission when failure rate exceeds 80%.
  This threshold helps guard against both poorly operated observers and
  widespread network issues. In the case of a widespread network issue, the
  assumption is that most gateway operators are well intentioned and will work
  together to troubleshoot and restore both observations and network stability,
  rather than submitting reports that would penalize functioning gateways.
- Updated default trusted gateway in docker-compose Envoy configuration to
  ar-io.net for improved robustness and alignment with core service
  configuration.
- Improved range request performance by passing ranges directly to getData
  implementations rather than streaming all data and extracting ranges.

### Fixed

- Fixed missing cache headers (`X-Cache` and other data headers) in range
  request responses to ensure consistent cache header behavior across all request
  types.
- Fixed async streaming for multipart range requests by using async iteration
  instead of synchronous reads, preventing potential data loss.
- Fixed ArNS resolution to properly exclude www subdomain from resolution
  logic.
- Fixed test reliability issues by properly awaiting stream completion before
  making assertions.
- Fixed chunk broadcasting to not await peer broadcasts, as they are
  best-effort operations.

## [Release 35] - 2025-05-19

This is a low upgrade priority release. It contains a small caching improvement
and routing fix. Upgrading to help test it is appreciated but not essential.

### Changed

- Adjusted filesystem data expiration to be based on last request times rather
  than file access times which may be inaccurate.
- Adjusted CORS headers to include `content-*` headers.

### Fixed

- Fixed regex used to expose `/api-docs` when an apex ArNS name is set.

## [Release 34] - 2025-05-05

Given the resilience provided by adding a second trusted gateway URL, it is
recommended that everyone upgrade to this release.

### Added

- Added peer list endpoints for retrieving information about Arweave peers and
  ar.io gateway peers.
- Added ar-io.net as a secondary trusted gateway to increase data retrieval
  resilience by eliminating a single point of failure.
- Added circuit breaker for Arweave peer chunk posting.

### Changed

- Created directories for DuckDB and Parquet to help avoid permission issues
  by the directories being created by containers.

### Fixed

- Fixed GraphQL ClickHouse error when returning block ID and timestamp.
- Fixed the tx-chunks-data-source to throw a proper error (resulting in a 404)
  when the first chunk is missing rather than streaming a partial response.

## [Release 33] - 2025-05-05

### Added

- Added a [Parquet and ClickHouse usage guide]. Using ArDrive as an example, it
  provides step by step instructions about how to bulk load Parquet and
  configure continuous ingest of bundled data items into ClickHouse. This
  allows the ar-io-node to support performant GraphQL queries on larger data
  sets and fascilitates sharing indexing work across gateways via distribution
  of Parquet files.
- Added support for configurable ArNS 404 pages using either:
  - `ARNS_NOT_FOUND_TX_ID`: Transaction ID for custom 404 content
  - `ARNS_NOT_FOUND_ARNS_NAME`: ArNS name to resolve for 404 content
- Added experimental `/chunk/<offset>` GET route for serving chunk data by
  absolute offset either the local cache.
- Added support for `AWS_SESSION_TOKEN` in the S3 client configuration.
- Expanded ArNS OTEL tracing to improve resolution behavior observability.
- Added support for setting a ClickHouse username and password via the
  `CLICKHOUSE_USERNAME` and `CLICKHOUSE_PASSWORD` environment variable. When
  using ClickHouse, `CLICKHOUSE_PASSWORD` should always be set. However,
  `CLICKHOUSE_USERNAME` can be left unset. The username `default` will be used
  in that case.
- Added support for configuring the port used to connect to ClickHouse via
  the `CLICKHOUSE_PORT` environment variable.

### Changed

- Disabled ClickHouse import timing logging by default. It can be enabled via
  environment variable - `DEBUG` when running the service standalone or
  `CLICKHOUSE_DEBUG` when using Docker Compose
- Upgraded to ClickHouse 25.4.

### Fixed

- Ensure `.env` is read in `clickhouse-import` script.

## [Release 32] - 2025-04-22

### Changed

- Reenabled parallel ArNS resolution with removal of misplaced global limit.
  Refer to release 30 notes for more details on configuration and rationale.
- Added a timeout for the last ArNS resolver in `ARNS_RESOLVER_PRIORITY_ORDER`.
  It defaults to 30 seconds and is configurable using
  `ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS`. This helps prevent promise build
  up if the last resolver stalls.

### Fixed

- Fixed apex ArNS name handling when a subdomain is present in
  `ARNS_ROOT_HOST`.
- Fixed a case where fork recovery could stall due to early flushing of
  unstable chain data.
- Restored observer logs by removing unintentional default log level override
  in `docker-compose.yaml`.

## [Release 31] - 2025-04-11

### Changed

- Improved peer TX header fetching by fetching from a wider range of peers and
  up/down weighting peers based on success/failure.

### Fixed

- Rolled back parallel ArNS resolution changes that were causing ArNS
  resolution to slow down over time.

## [Release 30] - 2025-04-04

### Added

- Added support for filtering Winston logs with a new `LOG_FILTER` environment
  variable.
  - Example filter: `{"attributes":{"class":"ArweaveCompositeClient"}}` to only
    show logs from that class.
  - Use `CORE_LOG_FILTER` environment variable when running with
    docker-compose.
- Added parallel ArNS resolution capability.
  - Configured via `ARNS_MAX_CONCURRENT_RESOLUTIONS` (default: 1).
  - This foundation enables future enhancements to ArNS resolution and should
    generally not be adjusted at present.

### Changed

- Improved ClickHouse auto-import script with better error handling and
  continuous operation through errors.
- Reduced maximum header request rate per second to trusted node to load on
  community gateways.
- Optimized single owner and recipient queries on ClickHouse with specialized
  sorted tables.
- Used ID sorted ClickHouse table for ID queries to improve performance.

### Fixed

- Fixed data alignment in Parquet file name height boundaries to ensure
  consistent import boundaries.
- Removed trailing slashes from AO URLs to prevent issues when passing them to
  the SDK.
- Only prune SQLite data when ClickHouse import succeeds to prevent data loss
  during exports.

## [Release 29] - 2025-03-21

### Changed

- Temporarily default to trusted gateway ArNS resolution to reduce CU load as
  much possible. On-demand CU resolution is still available as a fallback and
  the order can be modified by setting `ARNS_RESOLVER_PRIORITY_ORDER`.
- Remove duplicate network process call in on-demand resolver.
- Don't wait for network process debounces in the on-demand resolver.
- Slow network process dry runs no longer block fallback to next resolver.

### Added

- Added support for separate CUs URLs for the network and ANT processes via the
  `NETWORK_AO_CU_URL` and `ANT_AO_CU_URL` process URLs respectively. If either
  is missing the `AO_CU_URL` is used instead with a fallback to the SDK default
  URL if `AO_CU_URL` is also unspecified.
- Added CU URLs to on-demand ArNS resolver logs.
- Added circuit breakers for AR.IO network process CU dry runs. By default
  they use a 1 minute timeout and open after 30% failure over a 10 minute
  window and reset after 20 minutes.

### Fixed

- Owners in GraphQL results are now correctly retrieved from data based on
  offsets when using ClickHouse.

## [Release 28] - 2025-03-17

### Changed

- Raised name not found name list refresh interval to 2 minutes to reduce load
  on CUs. This increases the maximum amount of time a user may wait for a new
  name to be available. Future releases will introduce other changes to
  mitigate this delay.
- Adjusted composite ArNS resolver to never timeout resolutions from the last
  ArNS resolver in the resolution list.

### Added

- Added support for serving a given ID or ArNS name from the apex domain of a
  gateway. If using an ID, set the `APEX_TX_ID` environment variable. If using
  an ArNS name, set the `APEX_ARNS_NAME` environment variable.
- Added `BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS`,
  `BUNDLE_REPAIR_BACKFILL_INTERVAL_SECONDS`, and
  `BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS` environment variables to
  control the interval for retrying failed bundles, backfilling bundle records,
  and reprocessing bundles after a filter change. Note: the latter two are
  rairly used. Queuing bundles for reprocessing via the
  `/ar-io/admin/queue-bundle` endpoint is usually preferrable to automatic
  reprocessing as it is faster and offers more control over the reprocessing
  behavior.

### Fixed

- Signatures in GraphQL results are now correctly retrieved from data based on
  offsets when using ClickHouse.
- Adjusted exported Parquet file names to align with expectations of ClickHouse
  import script.
- Ensured that bundle indexing status is properly reset when bundles are
  manually queued after an unbundling filture change has been made.

## [Release 27] - 2025-02-20

### Changed

- Set process IDs for mainnet.
- Increase default AO CU WASM memory limit to 17179869184 to support mainnet
  process.

## [Release 26] - 2025-02-13

### Added

- Added a per resolver timeout in the composite ArNS resolver. When the
  composite resolver attempts resolution it is applied to each resolution
  attempt. It is configurable via the `ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS` and
  defaults to 3 seconds in order to allow a fallback attempt before the default
  observer timeout of 5 seconds.
- Added a `TURBO_UPLOAD_SERVICE_URL` environment variable to support
  configuration of the bundler used by the observer (TurboSDK defaults are
  used if not set).
- Added a `REPORT_DATA_SINK` environment variable that enables switching the
  method used to post observer reports. With the default, `turbo`, it sends
  data items via a Turbo compatible bundler. Switching it to `arweave` will
  post base layer transactions directly to Arweave instead.
- Added a `/ar-io/admin/bundle-status/<id>` endpoint that returns the counters
  and timestamps from the `bundles` row in `data.db`. This can be used for
  monitoring unbundling progress and scripting (e.g., to skip requeuing already
  queued bundles).
- Added more complete [documentation](docs/filters.md) for filters.

### Changed

- Use arweave.net as the default GraphQL URL for AO CUs since most gateways
  will not have a complete local AO data item index.
- Use a default timeout of 5 seconds when refreshing Arweave peers to prevent
  stalled peer refreshes.
- Cache selected gateway peer weights for the amount of time specified by the
  `GATEWAY_PEERS_WEIGHTS_CACHE_DURATION_MS` environment variable with a default
  of 5 seconds to avoid expensive peer weight recomputation on each request.
- Chunk broadcasts to primary nodes occur in parallel with a concurrency limit
  defaulting to 2 and configurable via the `CHUNK_POST_CONCURRENCY_LIMIT`
  environment variable.
- Added circuit breakers for primary chunk node POSTs to avoid overwhelming
  chunk nodes when they are slow to respond.

### Fixed

- Properly cleanup timeout and event listener when terminating the data
  root computation worker.
- Count chunk broadcast exceptions as errors in the
  `arweave_chunk_broadcast_total` metric.

## [Release 25] - 2025-02-07

### Added

- Added support for indexing and querying ECDSA signed Arweave transactions.
- Expanded the OpenAPI specification to cover the entire gateway API and
  commonly used Arweave node routes.
- ArNS undername record count limits are now enforced. Undernames are sorted
  based on their ANT configured priority with a fallback to name comparisons
  when priorities conflict or are left unspecified. Enforcement is enabled by
  default but can be disabled by setting the
  `ARNS_RESOLVER_ENFORCE_UNDERNAME_LIMIT` to `false`.

### Changed

- Renamed the `ario-peer` data source to `ar-io-peers` for consistency and
  clarity. `ario-peer` will continue to work for backwards compatibility but is
  considered deprecated.
- Use AR.IO gateway peers from the ar.io gateway address registry (GAR) as the
  last fallback for fetching data when responding to client data requests. This
  has the benefit of making the network more resilient to trusted gateway
  disruptions, but it can also result in nodes serving data from less trusted
  sources if it is not found in the trusted gateway. This can be disabled by
  using a custom `ON_DEMAND_RETRIEVAL_ORDER` that does not include
  `ar-io-peers`.
- Arweave data chunk requests are sent to the trusted node first with a
  fallback to Arweave peers when chunks are unavailable on the trusted node.
  This provides good performance by default with a fallback in case there are
  issues retrieving chunks from the trusted node.
- Increased the observer socket timeout to 5 seconds to accommodate initial
  slow responses for uncached ArNS resolutions.
- Disabled writing base layer Arweave signatures to the SQLite DB by default to
  save disk space. When signatures are required to satisfy GraphQL requests,
  they are retrieved from headers on the trusted node.

### Fixed

- Updated dependencies to address security issues.
- Improved reliability of failed bundle indexing retries.
- Fixed failure to compute data roots for verification for base layer data
  larger than 2GiB.
- Fixed observer healthcheck by correcting node.js path in healthcheck script.

## [Release 24] - 2025-02-03

### Added

- Added a `ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS` environment
  variable that determines the number of seconds before the end of the TTL at
  which to start attempting to refresh the ANT state.
- Added a `TRUSTED_GATEWAYS_REQUEST_TIMEOUT_MS` environment that defaults to
  10,000 and sets the number of milliseconds to wait before timing out request
  to trusted gateways.
- Added `BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS` and
  `BUNDLE_REPAIR_RETRY_BATCH_SIZE` environment variables to control the time
  between queuing batches of bundle retries and the number of data items
  retrieved when constructing batches of bundles to retry.
- Added support for configuring the ar.io SDK log level via the
  `AR_IO_SDK_LOG_LEVEL` environment variable.
- Added a `request_chunk_total` Prometheus counter with `status`, `source` (a
  URL) and `source_type` (`trusted` or `peer`) labels to track success/failure
  of chunk retrieval in the Arweave network per source.
- Added a `get_chunk_total` Prometheus metric to count chunk retrieval
  success/failure per chunk.
- Added `arns_cache_hit_total` and `arns_cache_miss_total` Prometheus counters
  to track ArNS cache hits and misses for individual names respectively.
- Added `arns_name_cache_hit_total` and `arns_name_cache_miss_total` Prometheus
  counters to track ArNS name list cache hits and misses
  respectively.
- Added a `arns_resolution_duration_ms` Prometheus metric that tracks summary
  statistics for the amount of time it takes to resolve ArNS names.

### Changed

- In addition to the trusted node, the Arweave network is now searched for
  chunks by default. All chunks retrieved are verified against data roots
  indexed from a trusted Arweave node to ensure their validity.
- Default to a 24 hour cache TTL for the ArNS name cache. Record TTLs still
  override this, but in cases where resolution via AO CU is slow or fails, the
  cache will be used. In the case of slow resolution, CU based resolution will
  proceed in the background and update the cache upon completion.
- Switched to the `ioredis` library for better TLS support.
- Updated minor dependency minor versions (more dependencies will be updated in
  the next release).
- Bundles imports will no longer be re-attempted for bundles that have already
  been fully unbundled using the current filters if they are matched or
  manually queued again.
- Replaced references `docker-compose` in the docs with the more modern `docker
compose`.

### Fixed

- Ensure duplicate data item IDs are ignored when comparing counts to determine
  if a bundle has been fully unbundled.
- Fixed worker threads failing to shut down properly when the main process
  stopped.
- Ensure bundle import attempt counts are incremented when bundles are skipped
  to avoid repeatedly attempting to import skipped bundles.
- Use observe that correctly ensure failing gateways are penalized in the AR.IO
  AO process.

## [Release 23] - 2025-01-13

### Added

- Added `FS_CLEANUP_WORKER_BATCH_SIZE`,
  `FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION`, and
  `FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION` environment variables to allow
  configuration of number of contiguous data files cleaned up per batch, the
  pause between each batch, and the pause before restarting the entire cleanup
  process again.
- Added `data_items_unbundled_total` Prometheus metric that counts the total
  number of data items unbundled, including those that did not match the
  unbundling filter.
- Added a `parent_type` label that can be one of `transaction` or `data_item`
  to data item indexing metrics.
- Added a `files_cleaned_total` total Prometheus metric to enable monitoring of
  contiguous data cleanup.
- Added support for specifying the admin API via a file specified by the
  `ADMIN_API_KEY_FILE` environment variable.
- Added experimental support for posting chunks in a non-blocking way to
  secondary nodes specified via a comma separate list in the
  `SECONDARY_CHUNK_POST_URLS` environment variable.

### Changed

- Renamed the `parent_type` lable to `contiguous_data_type` on bundle metrics
  to more accurately reflect the meaning of the label.
- Reduced the maximum time to refresh the ArNS name list to 10 seconds to
  minimize delays in ArNS availability after a new name is registered.
- Changed `/ar-io/admin/queue-bundle` to wait for `bundles` rows to be written
  to the DB before responding to ensure that errors that occur due to DB
  contention are not silently ignored.
- Data items are now flushed even when block indexing is stopped. This allows
  for indexing batches of data items using the admin API with block indexing
  disabled.
- Adjust services in `docker-compose` to use `unless-stopped` as their restart
  policy. This guards against missing restarts in the case where service
  containers exit with a success status even when they shouldn't.

### Fixed

- Added missing `created_at` field in `blocked_names` table.
- Fixed broken ArNS undername resolution.

## [Release 22] - 2024-12-18

### Added

- Added the ability to block and unblock ArNS names (e.g., to comply with
  hosting provider TOS). To block a name, POST `{ "name": "<name to block>" }`
  to `/ar-io/admin/block-name`. To unblock a name, POST
  `{ "name": "<name to unblock>" }` to `/ar-io/admin/unblock-name`.

### Changed

- Return an HTTP 429 response to POSTs to `/ar-io/admin/queue-bundle` when the
  bundle data import queue is full so that scripts queuing bundles can wait
  rather than overflowing it.

### Fixed

- Adjust ArNS length limit from <= 48 to <= 51 to match the limit enforced by
  the AO process.

## [Release 21] - 2024-12-05

### Added

- Added a ClickHouse auto-import service. When enabled, it calls the Parquet
  export API, imports the exported Parquet into ClickHouse, moves the Parquet
  files to an `imported` subdirectory, and deletes data items in SQLite up to
  where the Parquet export ended. To use it, run Docker Compose with the
  `clickhouse` profile, set the `CLICKHOUSE_URL` to `http://clickhouse:8123`,
  and ensure you have set an `ADMIN_KEY`.
  Using this configuration, the core service will also combine results from
  ClickHouse and SQLite when querying transaction data via GraphQL. Note: if
  you have a large number of data items in SQLite, the first export and
  subsequent delete may take an extended period. Also, this functionality is
  considered **experimental**. We expect there are still bugs to be found in it
  and we may make breaking changes to the ClickHouse schema in the future. If
  you choose to use it in production (not yet recommended), we suggest backing
  up copies of the Parquet files found in `data/parquet/imported` so that they
  can be reimported if anything goes wrong or future changes require it.
- Added a background data verification process that will attempt to recompute
  data roots for bundles and compare them to data roots indexed from Arweave
  nodes. When the data roots match, all descendant data items will be marked as
  verified. This enables verification of data initially retrieived from sources,
  like other gateways, that serve contiguous data instead of verifiable chunks.
  Data verification can be enabled by setting the
  `ENABLE_BACKGROUND_DATA_VERIFICATION` environment variable to true. The
  interval between attempts to verify batches of bundles is configurable using
  the `BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS` environment variable.
- Added a `CHUNK_POST_MIN_SUCCESS_COUNT` environment variable to configure how
  many Arweave nodes must accept a chunk before a chunk broadcast is considered
  successful.
- Added `arweave_chunk_post_total` and `arweave_chunk_broadcast_total`
  Prometheus metrics to respectively track the number of successful chunk POSTs
  to Arweave nodes and the number of chunks successfully broadcast.
- When resolving ArNS names, the entire list of names is now cached instead of
  individually checking whether each name exists. This reduces the load on AO
  CUs since the entire list can be reused across multiple requests for
  different names. Note: due to the default 5 minute interval between name list
  refreshes, newly registered may now take longer to resolver after initial
  registration. We intend to make further caching refinements to address this
  in the future.
- Added support for multiple prioritized trusted gateways configurable by
  setting the `TRUSTED_GATEWAYS_URLS` environment variable to a JSON value
  containing a mapping of gateway hosts to priorities. Data requests are sent
  to other gateways in ascending priority order. If multiple gateways share the
  same priority, all the gateways with the same priority are tried in a random
  order before continuing on to the next priority.
- Added support for caching contiguous data in S3. It is enabled by default
  when the `AWS_S3_CONTIGUOUS_DATA_BUCKET` and `AWS_S3_CONTIGUOUS_DATA_PREFIX`
  environment variables are set.

### Changed

- `trusted-gateway` was changed to `trusted-gateways` in
  `ON_DEMAND_RETRIEVAL_ORDER` and `BACKGROUND_RETRIEVAL_ORDER`.
- Renamed the S3 contiguous environment variables - `AWS_S3_BUCKET` to
  `AWS_S3_CONTIGUOUS_DATA_BUCKET` and `AWS_S3_PREFIX` to
  `AWS_S3_CONTIGUOUS_DATA_PREFIX`.

## [Release 20] - 2024-11-15

### Added

- Exposed the core service chunk POST endpoint via Envoy. It accepts a Arweave
  data chunk and broadcasts it to either the comma separated list of URLs
  specified by the CHUNK_POST_URLs environment variable or, if none are
  specified, the `/chunk` path on URL specified by the TRUST_GATEWAY_URL
  environment variable.
- Added a `X-AR-IO-Root-Transaction-Id` HTTP header to data responses
  containing the root base layer transaction ID for the ID in question if it's
  been indexed.
- Added a `X-AR-IO-Data-Item-Data-Offset` HTTP header containing the offset of
  the data item relative to the root bundle base layer transaction for it. In
  conjunction with `X-AR-IO-Root-Transaction-Id`, it enables retrieving data
  for data item IDs from base layer data using first a `HEAD` request to
  retrieve the root ID and data offset followed by a range request into the
  root bundle. This greatly increases the likelihood of retriving data item
  data by ID since only an index into the base layer and Arweave chunk
  availability is needed for this access method to succeed.
- Added an experimental ClickHouse service to `docker-compose.yaml` (available
  via the `clickhouse` profile). This will be used as a supplemental GraphQL DB
  in upcoming releases.
- Added a data item indexing healthcheck that can be enabled by setting the
  `RUN_AUTOHEAL` environment variable to `true`. When enabled, it will restart
  the `core` service if no data items have been indexed since the value
  specified by the `MAX_EXPECTED_DATA_ITEM_INDEXING_INTERVAL_SECONDS`
  environment variable.

## [Release 19] - 2024-10-21

### Fixed

- Adjusted data item flushing to use the bundle DB worker instead of the core
  DB worker to prevent write contention and failed flushes under heavy
  unbundling load.

### Added

- Added `X-AR-IO-Digest`, `X-AR-IO-Stable`, `X-AR-IO-Verified`, and `ETag`
  headers. `X-AR-IO-Digest` contains a base64 URL encoded representation of the
  SHA-256 hash of the data item data. It may be empty if the gateway has not
  previously cached the data locally. `X-AR-IO-Stable` contains either `true`
  or `false` depending on whether the associated Arweave transaction is more
  than 18 blocks old or not. `X-AR-IO-Verified` contains either `true` if the
  gateway has verified the data root of the L1 transaction or the L1 root
  parent of the data item or `false` if it has not. `ETag` contains the same
  value a `X-AR-IO-Digest` and is used to improve HTTP caching efficiency.
- Added support for using a different data source for on-demand and background
  data retrieval. Background data retrieval is used when unbundling. The
  background retrieval data source order is configurable using the
  `BACKGROUND_RETRIEVAL_ORDER` environment variable and defaults to
  `chunks,s3,trusted-gateway,tx-data`. Priority is given to chunk retrieval
  since chunks are verifiable.
- Added an `/ar-io/admin/export-parquet/status` to support monitoring of
  in-progress Parquet export status.
- Added `sqlite_in_flight_ops` Prometheus metric with `worker` (`core`,
  `bundles`, `data`, or `moderation`) and `role` (`read` or `write`) labels to
  support monitoring the number of in-flight DB operations.
- Added experimental Grafana and Prometheus based observability stack. See the
  "Monitoring and Observability" section of the README for more details.

### Changed

- Bundle data is now retrieved as chunks from Arweave nodes by default so that
  data roots can be compared against the chain (see entry about background
  retrieval above).
- Changed observer configuration to use 8 instead of 5 chosen names. These are
  combined with 2 names prescribed from the contract for a total of 10 names
  observed each epoch to provide increased ArNS observation coverage.
- Verification status is set on data items when unbundling a parent that has
  already been verified.

## [Release 18] - 2024-10-01

### Fixed

- Improved performance of data attributes query that was preventing `data.db`
  WAL flushing.

### Added

- Added WAL `sqlite_wal_checkpoint_pages` Prometheus metric to help monitor WAL
  flushing.
- Added a POST `/ar-io/admin/export-parquet` endpoint that can be used to
  export the contents of the SQLite3 core and bundle DBs as Parquet. To trigger
  an export, POST JSON containing `outputDir`, `startHeight`, `endHeight`, and
  `maxFileRows` keys. The resulting Parquet files can then be queried directly
  using DuckDB or loaded into another system (e.g. ClickHouse). Scripts will be
  provided to help automate the latter in a future release.
- Added `ARNS_RESOLVER_OVERRIDE_TTL_SECONDS` that can be used to force ArNS
  names to refresh before their TTLs expire.
- Added a GET `/ar-io/resolver/:name` endpoint that returns an ArNS resolution
  for the given name.

### Changed

- Removed ArNS resolver service in favor of integrated resolver. If a
  standalone resolver is still desired, the core service can be run with the
  `START_WRITERS` environment variable set to `false`. This will disable
  indexing while preserving resolver functionality.
- Deduplicated writes to `data.db` to improve performance and reduce WAL growth
  rate.

## [Release 17] - 2024-09-09

### Notes

- This release includes a **LONG RUNNING MIGRATION**. Your node may appear
  unresponsive while it is running. It is best to wait for it to complete. If
  it fails or is interrupted, removing your SQLite DBs (in `data/sqlite` by
  default) should resolve the issue, provided you are willing to lose your
  GraphQL index and let your node rebuild it.

### Fixed

- Use the correct environment variable to populate WEBHOOK_BLOCK_FILTER in
  `docker-compose.yaml`.
- Don't cache data regions retrieved to satisfy range requests to avoid
  unnecessary storage overhead and prevent inserting invalid ID to hash
  mappings into the data DB.

### Added

- Added a new ClickHouse based DB backend. It can be used in combination with
  the SQLite DB backend to enable batch loading of historical data from
  Parquet. It also opens up the possibility of higher DB performance and
  scalability. In its current state it should be considered a technology
  preview. It won't be useful to most users until we either provide Parquet
  files to load into it or automate flushing of the SQLite DB to it (both are
  planned in future release). It is not intended to be standalone solution. It
  supports bulk loading and efficient GraphQL querying of transactions and data
  items, but it relies on SQLite (or potentially another OLTP in the future) to
  index recent data. These limitations allow greatly simplified schema and
  query construction. Querying the new ClickHouse DB for transaction and data
  items via GraphQL is enabled by setting the 'CLICKHOUSE_URL' environment
  variable.
- Added the ability to skip storing transaction signatures in the DB by setting
  WRITE_TRANSACTION_DB_SIGNATURES to false. Missing signatures are fetched from
  the trusted Arweave node when needed for GraphQL results.
- Added a Redis backed signature cache to support retrieving optimistically
  indexed data item signatures in GraphQL queries when writing data items
  signatures to the DB has been disabled.
- Added on-demand and composite ArNS resolvers. The on-demand resolver
  fetches results directly from an AO CU. The composite resolver attempts
  resolution in the order specified by the ARNS_RESOLVER_PRIORITY_ORDER
  environment variable (defaults to 'on-demand,gateway').
- Added a queue_length Prometheus metric to fasciliate monitoring queues and
  inform future optimizations
- Added SQLite WAL cleanup worker to help manage the size of the `data.db-wal`
  file. Future improvements to `data.db` usage are also planned to further
  improve WAL management.

### Changed

- Handle data requests by ID on ArNS sites. This enables ArNS sites to use
  relative links to data by ID.
- Replaced ARNS_RESOLVER_TYPE with ARNS_RESOLVER_PRIORITY_ORDER (defaults to
  'on-demand,gateway').
- Introduced unbundling back pressure. When either data item data or GraphQL
  indexing queue depths are more than the value specified by the
  MAX_DATA_ITEM_QUEUE_SIZE environment variable (defaults to 100000),
  unbundling is paused until the queues length falls bellow that threshold.
  This prevents the gateway from running out of memory when the unbundling rate
  exceeds the indexing rate while avoiding wasteful bundle reprocessing.
- Prioritized optimistic data item indexing by inserting optimistic data items
  at the front of the indexing queues.
- Prioritized nested bundle indexing by inserting nested bundles at the front
  of the unbundling queue.

## [Release 16] - 2024-08-09

### Fixed

- Fixed promise leak caused by missing await when saving data items to the DB.
- Modified ArNS middleware to not attempt resolution when receiving requests
  for a different hostname than the one specified by `ARNS_ROOT_HOST`.

### Added

- Added support for returning `Content-Encoding` HTTP headers based on user
  specified `Content-Encoding` tags.
- Added `isNestedBundle` filter enables that matches any nested bundle when
  indexing. This enables composite unbundling filters that match a set of L1
  tags and bundles nested under them.
- Added ability to skip writing ANS-104 signatures to the DB and load them
  based on offsets from the data instead. This significantly reduces the size
  of the bundles DB. It can be enabled by setting the
  `WRITE_ANS104_DATA_ITEM_DB_SIGNATURES` environment variable to `false`.
- Added `data_item_data_indexed_total` Prometheus counter to count data items
  with data attributes indexed.

### Changed

- Queue data attributes writes when serving data rather than writing them
  syncronously.
- Reduced the default data indexer count to 1 to lessen the load on the data
  DB.
- Switched a number of overly verbose info logs to debug level.
- Removed docker-compose on-failure restart limits to ensure that services
  restart no matter how many times they fail.
- Modified the `data_items_indexed_total` Prometheus counter to count data
  items indexed for GraphQL querying instead of data attributes.
- Increased aggressiveness of contiguous data cleanup. It now pauses 5 seconds
  instead of 10 seconds per batch and runs every 4 hours instead of every 24
  hours.

## [Release 15] - 2024-07-19

### Fixed

- Fixed query error that was preventing bundles from being marked as fully
  imported in the database.

### Added

- Adjusted data item indexing to record data item signature types in the DB. This
  helps distinguish between signatures using different key formats, and will
  enable querying by signature type in the future.
- Adjusted data item indexing to record offsets for data items within bundles
  and signatures and owners within data items. In the future this will allow us
  to avoid saving owners and signatures in the DB and thus considerably reduce
  the size of the bundles DB.
- Added `ARNS_CACHE_TTL_MS` environment variable to control the TTL of ARNS cache
  entries (defaults to 1 hour).
- Added support for multiple ranges in a single HTTP range request.
- Added experimental chunk POST endpoint that broadcasts chunks to the
  comma-separate list of URLS in the `CHUNK_BROADCAST_URLS` environment
  variable. It is available at `/chunk` on the internal gateway service port
  (4000 by default) but is not yet exposed through Envoy.
- Added support for running an AO CU adjacent to the gateway (see README.md for
  details).
- Added `X-ArNS-Process-Id` to ArNS resolved name headers.
- Added a set of `AO_...` environment variables for specifying which AO
  URLs should be used (see `docker-compose.yaml` for the complete list). The
  `AO_CU_URL` is of particular use since the core and resolver services only
  perform AO reads and only the CU is needed for reads.

### Changed

- Split the monolithic `docker-compose.yaml` into `docker-compose.yaml`,
  `docker-compose.bundler.yaml`, and `docker-compose.ao.yaml` (see README for
  details).
- Replaced references to 'docker-compose' with 'docker compose' in the docs
  since the former is mostly deprecated.
- Reduce max fork depth from 50 to 18 inline to reflect Arweave 2.7.2 protocol
  changes.
- Increased the aggressiveness of bundle reprocessing by reducing reprocessing
  interval from 10 minutes to 5 minutes and raising reprocessing batch size
  from 100 to 1000.
- Use a patched version of Litestream to work around insufficient S3 multipart
  upload size in the upstream version.

## [Release 14] - 2024-06-26

### Fixed

- Correctly handle manifest `index` after `paths`.

## [Release 13] - 2024-06-24

### Added

- Added support for optimistically reading data items uploaded using the
  integrated Turbo bundler via the LocalStack S3 interface.
- Added `X-AR-IO-Origin-Node-Release` header to outbound data requests.
- Added `hops`, `origin`, and `originNodeRelease` query params to
  outbound data requests.
- Added support for `fallback` in v0.2 manifests that is used if no path in
  the the manifest is matched.

### Changed

- Updated Observer to read prescribed names from and write observations to the
  ar.io AO network process.
- Updated Resolver to read from the ar.io AO network process.

### Fixed

- Modified optimistic indexing of data items to use a null `parent_id` when
  inserting into the DB instead of a placeholder value. This prevents
  unexpected non-null `bundledIn` values in GraphQL results for optimistically
  indexed data items.
- Modified GraphQL query logic to require an ID for single block GraphQL
  queries. Previously queries missing an ID were returning an internal SQLite
  error. This represents a small departure from arweave.net's query logic which
  returns the latest block for these queries. We recommend querying `blocks`
  instead of `block` in cases where the latest block is desired.
- Adjusted Observer health check to reflect port change to 5050.

### Security

- Modified docker-compose.yaml to only expose Redis, PostgreSQL, and
  LocalStack ports internally. This protects gateways that neglect to deploy
  behind a firewall, reverse proxy, or load balancer.

## [Release 12] - 2024-06-05

### Added

- Added `/ar-io/admin/queue-data-item` endpoint for queuing data item
  headers for indexing before the bundles containing them are
  processed. This allows trusted bundlers to make their data items
  quickly available to be queried via GraphQL without having to wait for bundle
  data submission or unbundling.
- Added experimental support for retrieving contiguous data from S3. See
  `AWS_*` [environment variables documentation](docs/env.md) for configuration
  details. In conjuction with a local Turbo bundler this allows optimistic
  bundle (but not yet data item) retrieval.
- Add experimental support for fetching data from gateway peers. It can be
  enabled by adding `ario-peer` to `ON_DEMAND_RETRIEVAL_ORDER`. Note: do not
  expect this work reliably yet! This functionality is in active development
  and will be improved in future releases.
- Add `import_attempt_count` to `bundle` records to enable future bundle import
  retry optimizations.

### Changed

- Removed `version` from `docker-compose.yaml` to avoid warnings with recent
  versions of `docker-compose`
- Switched default observer port from 5000 to 5050 to avoid conflict on OS X.
  Since Envoy is used to provide external access to the observer API this
  should have no user visible effect.

## [Release 11] - 2024-05-21

### Added

- Added `arweave_tx_fetch_total` Prometheus metric to track counts of
  transaction headers fetched from the trusted node and Arweave network peers.

### Fixed

- Revert to using unnamed bind mounts due to cross platform issues with named
  volumes.

## [Release 10] - 2024-05-20

### Added

- Added experimental support for streaming SQLite backups to S3 (and compatible
  services) using [Litestream](https://litestream.io/). Start the service using
  the docker-compose 'litestream' profile to use it, and see the
  `AR_IO_SQLITE_BACKUP_*` [environment variables documentation](docs/env.md) for
  further details.
- Added `/ar-io/admin/queue-bundle` endpoint for queuing bundles for import
  before they're in the mempool. In the future, this will enable optimistic
  indexing when combined with a local trusted bundler.
- Added support for triggering webhooks when blocks are imported that match the
  filter specified by the `WEBHOOK_BLOCK_FILTER` environment variable.
- Added experimental support for indexing transactions and related data items
  from the mempool. Enable it by setting the `ENABLE_MEMPOOL_WATCHER` environment
  variable to 'true'.
- Made on-demand data caching circuit breakers configurable via the
  `GET_DATA_CIRCUIT_BREAKER_TIMEOUT_MS` environment variable. This allows gateway
  operators to decide how much latency they will tolerate when serving data in
  exchange for more complete data indexing and caching.
- Added `X-AR-IO-Hops` and `X-AR-IO-Origin` headers in preparation for future
  peer-to-peer data functionality.

### Changed

- Renamed cache header from `X-Cached` to `X-Cache` to mimic typical CDN
  practices.
- Upgrade to Node.js v20 and switch to the native test runner.

## [Release 9] - 2024-04-10

### Added

- Added experimental Farcaster Frames support enabling simple Areave based
  Frames with button navigation. Transaction and data item data is now served
  under `/local/farcaster/frame/<ID>`. `/local` is used as a prefix to indicate
  this functionality is both experimental and local to a particular the gateway
  rather than part of the global gateway API. Both GET and POST requests are
  supported.
- Added an experimental local ArNS resolver. When enabled it removes dependence
  on arweave.net for ArNS resolution! Enable it by setting `RUN_RESOLVER=true`,
  `TRUSTED_ARNS_RESOLVER_TYPE=resolver`, and
  `TRUSTED_ARNS_RESOLVER_URL=http://resolver:6000` in your `.env` file.
- Added a `CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD` environment variable
  that represents a threshold age in seconds to be compared with a contiguous
  data file age. If file is older than the amount of seconds set in the
  enviroment variable it will be deleted.
- Added an 'X-Cached' header to data responses to indicate when data is served
  from the local cache rather than being retrieved from an external source. This
  is helpful for interfacing with external systems, debugging, and end-to-end
  testing.
- Save hashes for unbundled data items during indexing. This enables reduction
  in data storage via hash based deduplication as well as more efficient
  peer-to-peer data retrieval in the future.

## [Release 8] - 2024-03-14

### Added

- Add GraphQL SQL query debug logging to support trouble shooting and
  performance optimization.
- Add support for indexing data items (not GraphQL querying) based solely on
  tag name (example use case: indexing all IPFS CID tagged data items).

### Changes

- Observer data sampling now uses randomized ranges to generate content hashes.
- Reference gateway ArNS resolutions are now cached to improve report
  generation performance.
- Contract interactions are now tested before posting using `dryWrite` to avoid
  submitting interactions that would fail.
- `/ar-io/observer/info` now reports `INVALID` for wallets that fail to load.

### Fixed

- Fix data caching failure caused by incorrect method name in getData\* circuit
  breakers.
- Fix healthcheck when ARNS_ROOT_HOST includes a subdomain.

## [Release 7] - 2024-02-14

### Added

- Add support for notifiying other services of transactions and data items
  using webhooks (see README for details).
- Add support for filter negation (particularly useful for excluding large
  bundles from indexing).
- Improve unbundling throughput by decoupling data fetching from unbundling.
- Add Envoy and core service ARM builds.

### Changed

- Improve resource cleanup and shutdown behavior.
- Don't save Redis data to disk by default to help prevent memory issues on
  startup for small gateways.
- Reduce the amount of data sampled from large files by the observer.
- Ensure block poa2 field is not cached to reduce memory consumption.

## [Release 6] - 2024-01-29

### Fixed

- Update observer to improve reliability of contract state synchronization and
  evaluation.

## [Release 5] - 2024-01-25

### Added

- Added transaction offset indexing to support future data retrieval
  capabilities.
- Enabled IPv6 support in Envoy config.
- Added ability to configure observer report generation interval via the
  REPORT_GENERATION_INTERVAL_MS environment variable (intended primarily for
  development and testing).

### Changed

- Updated observer to properly handle FQDN conflicts.
- Renamed most created_at columns to indexed_at for consistency and clarity.

### Fixed

- Updated LMDB version to remove Buffer workaround and fix occassional block
  cache errors.

## [Release 4] - 2024-01-11

### Added

- Added circuit breakers around data index access to reduce impact of DB access
  contention under heavy requests loads.
- Added support for configuring data source priority via the
  ON_DEMAND_RETRIEVAL_ORDER environment variable.
- Updated observer to a version that retrieves epoch start and duration from
  contract state.

### Changed

- Set the Redis max memory eviction policy to `allkeys-lru`.
- Reduced default Redis max memory from 2GB to 256MB.
- Improved predictability and performance of GraphQL queries.
- Eliminated unbundling worker threads when filters are configured to skip
  indexing ANS-104 bundles.
- Reduced the default number of ANS-104 worker threads from 2 to 1 when
  unbundling is enabled to conserve memory.
- Increased nodejs max old space size to 8GB when ANS-104 workers > 1.

### Fixed

- Adjusted paths for chunks indexed by data root to include the full data root.

## [Release 3] - 2023-12-05

### Added

- Support range requests ([PR 61], [PR 64])
  - Note: serving multiple ranges in a single request is not yet supported.
- Release number in `/ar-io/info` response.
- Redis header cache implementation ([PR 62]).
  - New default header cache (replaces old FS cache).
- LMDB header cache implementation ([PR 60]).
  - Intended for use in development only.
  - Enable by setting `CHAIN_CACHE_TYPE=lmdb`.
- Filesystem header cache cleanup worker ([PR 68]).
  - Enabled by default to cleanup old filesystem cache now that Redis
    is the new default.
- Support for parallel ANS-104 unbundling ([PR 65]).

### Changed

- Used pinned container images tags for releases.
- Default to Redis header cache when running via docker-compose.
- Default to LMDB header cache when running via `yarn start`.

### Fixed

- Correct GraphQL pagination for transactions with duplicate tags.

[Parquet and ClickHouse usage guide]: ./docs/parquet-and-clickhouse-usage.md
[PR 68]: https://github.com/ar-io/ar-io-node/pull/68
[PR 65]: https://github.com/ar-io/ar-io-node/pull/65
[PR 64]: https://github.com/ar-io/ar-io-node/pull/64
[PR 62]: https://github.com/ar-io/ar-io-node/pull/62
[PR 61]: https://github.com/ar-io/ar-io-node/pull/61
[PR 60]: https://github.com/ar-io/ar-io-node/pull/60
