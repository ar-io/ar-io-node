# PE-9087 (GraphQL cancellation + signal plumbing) — validation status and open questions

**Branch:** `PE-9087_graphql_cancellation_plumbing`
**Commits:**
- `86950b10` — feat(graphql): plumb AbortSignal through resolvers + fetchers
- `3212ec5b` — fix(database): return wallet owner in getTransactionAttributes
- `ffc97c4a` — feat(metrics): GraphQL + attribute-fetcher metrics for source attribution

**Deploy state:** indexer container on both gw1 and gw2 are running the
above. The gateway-core (`ar-io-node-core-1`) has NOT been redeployed —
the new metrics + bug fix only run on the indexer side, which is the
side that fans out GraphQL fetcher work.

## What's been validated

### 1. Cancellation plumbing works (PE-9087 itself)

Pre-deploy gw1 ran up `arweaveClientRequests` to ~660 k pending and
hit V8 OOM (~16 GiB) with autoheal at ~07:00 UTC overnight. Same
workload, post-PE-9087 gw2 kept the queue at 0, V8 at ~1 GiB, no
restart. The contrast is the cleanest A/B we have for this PR.

### 2. The `getTransactionAttributes` bug fix is live and producing real wins

The `attribute_fetch_total{kind="owner",subject="transaction",source="attributes",outcome="hit"}`
label combination is firing on both hosts. Pre-fix this label
combination was structurally impossible to emit (the typo guaranteed
`row.owner` was always returned as `null` regardless of whether
`wallets.public_modulus` was populated). Its appearance is the proof.

Throughput increased ~5–10× per host, not just *shifted*: the system
was completion-bottlenecked (each L1-tx owner fetch was paying ~10 s
of "wait → client disconnect → abort"), not query-volume-bottlenecked.
With local-DB resolution the same incoming GraphQL traffic now
resolves at sub-millisecond per query.

### 3. Both hosts converge to similar post-fix steady state

`attributes:hit` rate ~5 ops/sec per host, `chain:aborted` residual
~0.2 ops/sec per host. Load balancing healthy.

### 4. The new metric set tells the story without log scraping

Source-attribution panels and per-source p95 latency expose:
- Where each owner/signature resolution comes from (store, attributes,
  parent_data, chain, derived, incomplete_root).
- How long each path takes at p95.
- The deploy discontinuity at 17:00 UTC was visible to the second.

## What's still in question

### A. Disconnect-rate panel shows >100 %

`graphql_resolver_cancellations_total / graphql_queries_total` is
returning ratios above 1.0. That's structurally impossible for a
ratio of cancellations to queries — every cancelled query is, by
definition, also a query.

Most likely cause: the two counters increment in different scopes.
- `graphql_queries_total` increments inside `withQueryMetrics`, which
  wraps each *top-level Query resolver*. Skipped for requests that
  don't fire a Query resolver: introspection (`__schema`, `__type`),
  malformed queries that fail validation pre-resolution, mutations,
  subscriptions.
- `graphql_resolver_cancellations_total` increments from the abort
  handler in `buildResolverSignal`, which is set up unconditionally
  when the Apollo context factory runs.

So introspection-type traffic that gets aborted contributes to the
numerator without contributing to the denominator. If introspection
is a non-trivial share of inbound traffic, ratio > 1 follows.

**Action:** add a third counter, `graphql_requests_total`, incremented
once per request from an Apollo plugin's `requestDidStart` hook (or
similar request-level seam). Use that as the disconnect-rate
denominator. Keep `graphql_queries_total` as a per-resolver metric for
resolver-shape analysis. Detail in "Next moves" below.

### B. The `chain` path is essentially never `outcome=hit`

For both `kind=owner subject=transaction` and `kind=signature
subject=transaction`, every `source=chain` observation we've collected
post-deploy shows `outcome=aborted`, not `hit`. Chain calls aren't
returning successful values — every one we make times out and is
killed by the cancellation signal.

The system was *designed* with this fallthrough as the supported path
for L1-tx attribute fetches (signatures explicitly, owners as a backup
when the wallet table doesn't have the row). It's not working as
designed. Three competing hypotheses:

1. **`TRUSTED_NODE_URL` upstream is saturated.** Default is
   `https://arweave.net`. Every indexer in the world hits the same
   endpoint; we're competing for capacity.
2. **`trustedNodeRequestQueue` throttle starves chain fetches.**
   `composite-client.ts` has a token-bucket rate limiter
   (`maxRequestsPerSecond`) on outbound calls. If set conservatively,
   calls queue internally, the abort fires before they reach the
   wire, and the histogram sees only aborted observations.
3. **Per-request axios timeout is shorter than the queue wait.**
   If `chunkGeometryTimeoutMs` is e.g. 5 s, but a request waits
   7 s in the throttle queue before dispatch, axios times out
   before any HTTP call.

These are testable from indexer config + a few log probes. **Until
this is understood, the system has a known gap on signatures: every
L1-tx signature fetch fails.** Owner queries are mostly fine post-fix
because the wallets table catches them; signatures have no equivalent
local fallback.

The owner of this question takes the position: fix the chain path
to actually work as designed, do not enable
`WRITE_TRANSACTION_DB_SIGNATURES` (would store signatures locally
and bypass chain entirely). The flag exists; design is for
on-demand chain fetch.

### C. `parent_data:aborted` is the largest single cancellation source

Data-item attribute fetches via `fetchDataFromParent` are the
dominant cancellation surface (largest line on the source-attribution
panel). These are "fetch a 512-byte range of a parent bundle from
turbo-gateway.com" — which routes back through the gw-core's chain.
Cancellation is doing its job (no zombie work), but the underlying
latency of these range fetches still dominates aborts.

Adjacent question: does cross-mounting the indexer's
`/var/lib/ar-io-node/caches/indexer/contiguous` into the gw-core
container as a read-only secondary `FsDataStore` help? Earlier
sampling showed 6/10 random parent bundles cached on the indexer
side and 0/10 on the gw-core side. But our subsequent failed-fetch
sampling showed most of the *failing* fetches are for L1 txs (not
data items in the indexer's index), so the value of cross-mounting
the cache is narrower than initially claimed.

### D. Residual `owner:transaction:chain:aborted` rate (~0.2 ops/sec per host)

Post-fix, ~0.2 ops/sec per host of L1-tx owner fetches still falls
through to chain. These are L1 txs whose `owner_address` has no row
in the local `wallets` table. Could be:
- Recent txs not yet block-imported.
- Edge cases in block-import (wallet not extracted from owner field).
- Unknown.

Not blocking; worth understanding to set expectations.

## Adjacent operational findings (from the canary investigation)

These are NOT blocking the PE-9087 deploy but were uncovered while
investigating disconnects, and are worth their own threads.

1. **gw-core's `turbo_elasticache` circuit breaker is permanently
   open** (1,722 opens since gw-core start). The breaker fails fast,
   so the chain falls through correctly, but every gw-core request
   pays this overhead. Investigate why Redis is unhealthy from the
   gw-core perspective.
2. **`TxMetadataResolver` "Skipping remote resolve, at concurrency
   limit"** fires on the gw-core for some indexer-side requests.
   Concurrency limit is dropping work silently.
3. **402s on `/raw/:id` to gw-core** are from peer-gateway relay
   traffic, NOT from the indexer (the indexer's source IP is in
   `RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST` and gets 0 × 402). Separate
   peer-gateway misconfig issue.
4. **gw-core 5xx rate spiked 7× during the post-PE-9087 window** on
   gw2. PE-9087 didn't break the gateway — it removed the indexer-side
   stall and uncovered gw-core's capacity ceiling. Worth its own
   capacity discussion.
5. **Prometheus scrape interval is 300 s.** That's unusually long for
   an active service and means rate windows must be ≥ 20 m to be
   reliable. Worth tuning down to 30–60 s for the indexer at least.
6. **`saveBundle` mean SQLite write latency is ~234 ms** on gw2 vs
   1–3 ms for `saveDataItem`. Possibly queue-wait-time inclusion in
   the metric, possibly genuine UPSERT amplification. Worth a look.
7. **bundleDataImporter saturated at its 1000 cap** continuously on
   both hosts. Not blocking ingestion (downstream still drains) but
   the cap is the steady-state ceiling, which means the importer
   worker is the bottleneck on bundle inflow.

## Next moves, prioritized

### Now (blocking the disconnect-rate signal)

1. **Add `graphql_requests_total` counter** via an Apollo plugin's
   `requestDidStart` hook. Use as the disconnect-rate denominator.
   Tiny code change. Without this, we cannot trust the disconnect-rate
   panel's absolute values — only its trend direction.

### Next (chain path investigation, design-respecting)

2. **Inspect indexer `.env`** for `TRUSTED_NODE_URL`,
   `TRUSTED_NODE_*REQUESTS_PER_SECOND`, and any axios timeout knobs
   that affect `chainSource.getTxField`. Document current values.
3. **Pull `arweave_*` per-method counters** from the indexer to see
   actual chain success/failure rate breakdown.
4. **Sample a handful of `signature:transaction:chain:aborted` ids
   and curl-time the matching `/tx/{id}/signature` endpoint** directly
   from the indexer host. This bisects: if curl returns in 200 ms,
   the bottleneck is on our side (queue/throttle/timeout); if it
   returns in 30 s or 404s, the upstream is the problem.
5. **Decide on the right chain knob to turn**: raise rate limit, swap
   `TRUSTED_NODE_URL` to a lower-contention upstream, or extend
   axios timeout. The data from (2)-(4) tells us which.

### Adjacent (not blocking PE-9087)

6. **Add `outcome` label to the `attribute_fetch_duration_seconds`
   histogram** so p99 of `chain:hit` (when it ever happens) and p99
   of `chain:aborted` can be charted separately. Cardinality goes
   from 24 → 96 series, still small.
7. **Investigate residual `owner:transaction:chain:aborted` ids**
   to understand the wallets-table miss pattern.
8. **Consider tuning Prometheus scrape interval** from 300 s → 30–60 s
   on the indexer job for finer observability.
9. **Cross-mount caches** between indexer and gw-core (`MultiFsDataStore`
   sketch from earlier) — narrower payoff than initially thought
   since most failures are L1-tx not data-item, but not zero benefit.

## Decisions deferred

- `WRITE_TRANSACTION_DB_SIGNATURES=true` — owner of the question
  prefers to make chain work as designed. This flag stays at default
  unless the chain investigation surfaces a structural reason chain
  cannot meet the SLA.
- Lowering disconnect-rate alert thresholds — wait until the metric is
  trustworthy (after move #1 above).
