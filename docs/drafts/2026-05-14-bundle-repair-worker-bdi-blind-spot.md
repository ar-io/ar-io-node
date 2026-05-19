# `BundleRepairWorker` is structurally blind to BDIs

**Date:** 2026-05-14
**Status:** Diagnosis complete; fix design proposed below
**Related:** [2026-05-13 GQL parity & prune no-op investigation](./2026-05-13-gql-parity-and-prune-noop-investigation.md)

## TL;DR

Approximately **74% of the failed-bundle pool on the Turbo indexers
(~37K of ~50K on gw2) is nested Bundle Data Items (BDIs)** — not L1
transactions. The repair worker dispatches every failed bundle through
`TransactionFetcher`, which queries chain protocol nodes via
`http://envoy:3000/tx/<id>`. Chain nodes do not model BDIs, so the
fetch returns 404 for every retry of every BDI, forever. The repair
worker never reaches the data-source layer that knows how to resolve
BDIs (via `RootParentDataSource` + `Ans104OffsetSource`), because the
flow short-circuits at the L1-tx prefetch step well upstream of any
`ContiguousDataSource`. The capability to fetch BDIs exists in the
codebase; the wiring through the repair worker does not.

## How we got here

While diagnosing why ArDrive backfill bundles weren't draining from
the failed pool, we traced one bundle (`8MvrfFVB6H65TuBF-HSh0_lzs2TSaFyLuI6ZDFoGCjg`)
end-to-end through `BundleRepairWorker.retryBundles()`. It surfaced as
a stuck retry on chain `/tx/<id>` 404s. Per
[arscan.io](https://arscan.io/tx/8MvrfFVB6H65TuBF-HSh0_lzs2TSaFyLuI6ZDFoGCjg)
that id is a BDI — i.e. a nested data item shaped like a bundle, not
an L1 transaction. Chain nodes have never indexed it, and never will:
they only know L1.

A pool-wide query confirmed the same shape applies to most of the
backlog:

```sql
SELECT
  CASE WHEN id = root_transaction_id THEN 'L1 bundle' ELSE 'BDI nested' END AS shape,
  COUNT(*) AS cnt
FROM bundles
WHERE matched_data_item_count IS NOT NULL
  AND matched_data_item_count > 0
  AND last_fully_indexed_at IS NULL
  AND last_skipped_at IS NULL
GROUP BY shape;
```

gw2 returns:

| shape | count |
|---|---|
| BDI nested | 37,154 |
| L1 bundle  | 12,751 |

The 12.7K "L1" entries include some misclassified BDIs (like `8Mvr`,
where our DB has `id == root_transaction_id` but the underlying object
is actually nested). The misclassified subset is **out of scope** for
this fix — handled in a follow-up.

## Why the current path fails for BDIs

`BundleRepairWorker.retryBundles()` is shape-blind:

```ts
async retryBundles() {
  const bundleIds = await this.bundleIndex.getFailedBundleIds(BATCH_SIZE);
  for (const bundleId of bundleIds) {
    await this.bundleIndex.saveBundleRetries(bundleId);
    await this.txFetcher.queueTxId({ txId: bundleId });
  }
}
```

It treats every failed bundle id as an L1 tx id. `TransactionFetcher`
calls `ArweaveCompositeClient.getTxPrefetch(txId)` which routes through
the indexer envoy's `trusted_arweave_nodes` cluster (Arweave chain
protocol nodes at port 1984). For BDIs, that endpoint always 404s.
After 5 retries (~35s per bundle), `TransactionFetcher` gives up; the
bundle stays in the failed pool with a bumped `retry_attempt_count`.
The unbundler is never invoked, so the data-source layer is never
consulted.

Verified by tracing `8Mvr`'s repair lifecycle in `ar-io-node-indexer-core-1`
logs:

```text
18:03:28.241  BundleRepairWorker   Retrying failed bundle  bundleId=8Mvr...
18:03:28.242  TransactionFetcher   Queuing transaction...
18:03:28.242  TransactionFetcher   Transaction already queued.
                                   (26 minutes of silence while queue grinds others)
18:29:34.470  TransactionFetcher   Fetching transaction...
18:29:36.374  ArweaveCompositeClient  Transaction prefetch failed: 404
18:29:36.375  TransactionFetcher   Failed to fetch transaction
                                   (5-second backoff, retry, same outcome × 5)
```

A direct test against one of the configured upstream chain nodes
confirms `Not Found` for the BDI's id via `/tx/<id>/status` — the
chain has no record of the BDI as an L1 transaction.

## What's missing in the indexer state

For the 37K **known BDIs** (where `bundles.id != bundles.root_transaction_id`):

- `bundles.root_transaction_id` contains the parent L1 id ✓
- `stable_data_items` rows for these ids are absent (the LEFT JOIN
  returns NULL for `data_offset`, `data_size`, `root_parent_offset`,
  `height`). The BDIs are tracked as bundles but never landed as
  fully-attributed data items.

The parent-id reference is sufficient context to recover them: with
the parent L1 id, we can fetch the parent's bytes via the existing
data source chain (which includes the AWS legacy gateway as a
priority-2 trusted gateway, and that gateway already has these
parents indexed — verified earlier by fetching `/raw/<BDI_id>` and
getting 200 with full-body responses). The missing offset and size
can be discovered on demand by streaming the parent's ANS-104 header —
which is exactly what `Ans104OffsetSource` does.

### A note on the data source the unbundler actually uses

`Ans104Unbundler` is wired with `backgroundContiguousDataSource`
(`src/system.ts:1199-1207`), which composes the data sources named in
`BACKGROUND_RETRIEVAL_ORDER`. On the Turbo indexers this env is
`trusted-gateways,chunks` — both *non-offset-aware* variants.
`RootParentDataSource` is configured separately (as
`offsetAwareGatewaysDataSource` and `txChunksOffsetAwareSource`,
`src/system.ts:923,937`) but **not** in the background retrieval
order, so the unbundler doesn't transparently see BDIs.

That's fine for this fix: the proposed flow re-queues the **parent
L1** to the unbundler, and the parser then asks the data source for
`rootTxId + offset`, which the regular `gatewaysDataSource` can serve
with a `Range` header. Offset-aware sources are only needed if you ask
for a BDI by its own id; the unbundler's flow uses parent + offset
directly. No change to `BACKGROUND_RETRIEVAL_ORDER` required.

## The capability that exists but isn't wired

Two data sources are already present:

- **`RootParentDataSource`** (`src/data/root-parent-data-source.ts`) —
  a `ContiguousDataSource` that resolves a data item to its root
  parent and slices the parent's bytes for the requested region. Uses
  `Ans104OffsetSource` to discover offsets when they're not in the
  attributes store.
- **`Ans104OffsetSource`** (`src/data/ans104-offset-source.ts`) —
  given a parent bundle's byte stream, parses the ANS-104 header and
  enumerates each top-level data item's offset and size. Streams the
  prefix only; doesn't need the full payload.

`Ans104Unbundler.unbundle()` already branches on BDI vs L1:

```ts
if ('root_tx_id' in item && item.root_tx_id !== null) {
  rootTxId = item.root_tx_id;     // BDI path
} else if ('last_tx' in item) {
  rootTxId = item.id;              // L1 path
}
```

And further down, when `isNormalizedBundleDataItem(item)` is true and
the offsets are non-null, it computes the absolute offset within the
root tx and tells `Ans104Parser.parseBundle` to read from there.

So the unbundler is BDI-aware. The data-source layer can resolve BDIs.
**The gap is at the upstream**: the repair worker doesn't construct a
BDI-shaped `UnbundleableItem`; it just hands the id to
`TransactionFetcher` and walks away.

## Proposed fix

**Branch `BundleRepairWorker.retryBundles()` on shape.** For each
failed bundle:

1. If `id == root_transaction_id`: existing L1 path — queue to
   `TxFetcher` as today.
2. If `id != root_transaction_id`: BDI path — bypass `TxFetcher`
   entirely. Re-queue the **parent L1** (`root_transaction_id`) to
   `Ans104Unbundler.queueItem(...)` with `bypassFilter=true`. The
   parent's data fetch goes through the existing
   `contiguousDataSource` chain (which on these hosts includes the
   AWS legacy gateway), `Ans104Parser` walks the parent's header,
   discovers each first-level item including our BDI with correct
   offsets, and the BDI naturally re-enters the unbundle pipeline with
   complete metadata.

We're not building a new code path — we're routing BDIs through the
already-tested parent-unbundle path. The parent doesn't have to be in
a "failed" state; using `bypassFilter=true` re-processes it on
demand.

### Why re-queueing the parent (rather than the BDI directly)

Two alternatives were considered:

- **(B) Queue the BDI directly to the unbundler with `root_tx_id` set
  and offsets unknown.** The unbundler falls back to
  `rootParentOffset=0` and tells the parser to read from the start of
  the root. The parser then parses the L1 (not the BDI) and emits the
  L1's children — including the BDI again — with correct offsets at
  that point. Functionally similar to (A) but uses a misleading
  `parentId` and routes events through an artificial container, which
  could pollute downstream rows with the wrong parent context.

- **(C) Resolve the BDI's offset via `Ans104OffsetSource` first, then
  queue with offsets populated.** Cleanest in principle but adds new
  orchestration in the repair worker. The parent-re-queue approach
  reuses code that already calls `Ans104OffsetSource` (via
  `Ans104Parser.parseBundle`'s scan) as a side effect.

(A) is the smallest delta with the lowest semantic risk.

### Dedup and load shaping

Multiple failed BDIs commonly share a parent (our sample showed parent
`BDB8D1B27CA8317D...` and `B20D602E06821FE0...` each appearing for
several BDIs in a five-row sample). The retry batch should dedupe by
`root_transaction_id` before re-queuing, so we don't enqueue the same
parent N times.

### Queue routing

`Ans104Unbundler.queueItem()` accepts a `prioritized` flag. Repair-driven
re-queues should be **non-prioritized** so they don't preempt chain-tip
ingest. The unbundler's existing queue-full skip logic
(`bundles_unbundle_skipped_total{reason="queue_full"}`) handles
backpressure: if the queue is saturated, repairs naturally back off.

### What the repair worker now does, step by step

```ts
async retryBundles() {
  await this.measure('retry', async () => {
    const bundleIds = await this.bundleIndex.getFailedBundleIds(BATCH_SIZE);
    const shapeInfo = await this.bundleIndex.getBundleShapes(bundleIds);
    // shapeInfo[id] = { isBdi: bool, rootTxId: Buffer }

    const parentL1sToReunbundle = new Set<string>();
    for (const bundleId of bundleIds) {
      const info = shapeInfo[bundleId];
      await this.bundleIndex.saveBundleRetries(bundleId);

      if (info.isBdi) {
        parentL1sToReunbundle.add(info.rootTxId);   // dedupe
        metrics.bundleRepairRetriesCounter.inc({ kind: 'retry', shape: 'bdi' });
      } else {
        await this.txFetcher.queueTxId({ txId: bundleId });
        metrics.bundleRepairRetriesCounter.inc({ kind: 'retry', shape: 'l1' });
      }
    }

    for (const parentL1 of parentL1sToReunbundle) {
      await this.ans104Unbundler.queueItem(
        buildPartialL1Item(parentL1),
        false /* not prioritized */,
        true /* bypassFilter */,
      );
    }
  });
}
```

The `buildPartialL1Item` helper constructs a minimal `PartialJsonTransaction`-
shaped object from what we have in the `bundles` and (probably)
`stable_transactions` rows for that parent L1 — enough for the
unbundler to invoke the parser.

## Open questions / risks

1. **The parent L1's row may not be in `core.stable_transactions`
   either.** If we never indexed the parent's chain-side data, we
   can't build a `PartialJsonTransaction` from local state and we'd
   need to fetch the L1 first via `TxFetcher` — which puts us back in
   the original failure mode if the L1 itself is one of the genuinely
   old txs the chain nodes have aged out. Need to measure: of the 37K
   BDI parents, how many do we already have indexed locally?
2. **`bypassFilter=true` re-emits every child of the parent**, not
   just our target BDI. For a 100K-item bundle that's a lot of redundant
   work. Might be fine (events are cheap; the indexer dedupes inserts
   via upsert) but warrants measurement.
3. **Memory pressure under heavy retry**: a single retry cycle could
   schedule N parents to re-unbundle; each unbundle parses a full L1
   bundle. The existing `ANS104_UNBUNDLE_FILTER`'s queue-full skip
   should backpressure cleanly, but we should watch the dataItemIndexer
   queue depth during the first deploy.
4. **Race against the auto-import**: re-unbundling a parent emits
   data-item rows with fresh `indexed_at`, which interacts with the
   prune semantics already documented in
   [the 2026-05-13 investigation](./2026-05-13-gql-parity-and-prune-noop-investigation.md).
   Not a new problem, but the repair workload will continue to fight
   the prune for the same reason. Acceptable for the immediate fix.

## Out of scope

- **Misclassified BDIs** (the 12.7K "L1" entries that are actually
  nested but recorded with `id == root_transaction_id`). These need a
  separate metadata-bootstrap pathway: either the backfill driver
  supplies parent context at queue time, or we query an upstream
  metadata source (e.g. AWS legacy GraphQL) to learn the parent.
  Tracked separately.
- **Optimizing offset discovery to avoid full-parent re-emission**.
  Could be done by queuing the BDI directly with offsets resolved
  in-line via `Ans104OffsetSource`, but adds complexity. Defer until
  we have measurements showing parent-re-unbundle is too expensive.
- **The chain-node 404 path for genuinely-old L1 bundles**. Some of
  the 12.7K "L1" entries are real L1s whose chain-side state has aged
  out. They need a different fix (gateway-based `/tx/<id>` fallback
  in `ArweaveCompositeClient`'s prefetch path). Tracked separately.

## Implementation plan

1. **Add bundle-shape lookup to `BundleIndex`.** New method
   `getBundleShapes(ids: string[]): Map<id, { isBdi, rootTxId }>` that
   queries the bundles table for `id` and `root_transaction_id` in one
   round-trip. Add interface signature in `types.d.ts`, SQL in
   `src/database/sql/bundles/repair.sql`, worker impl in
   `StandaloneSqliteDatabase`, queue wrapper in main DB class,
   case handler in worker message handler (the five-edit dance).
2. **Add the `parent-L1-re-unbundle` branch to `retryBundles`.**
   Construct the minimal item via a helper, dedup by parent, queue.
3. **Label the existing `bundle_repair_retries_total` counter with a
   `shape` label** so we can see how many retries take each path.
4. **Test:** add a unit test for the new branching in
   `bundle-repair-worker.test.ts` (existing test file). Use a fake
   `BundleIndex` and a fake unbundler that records `queueItem` calls.
   Assert that BDIs lead to a single parent-L1 queue per unique
   parent, and L1s still go through `TxFetcher`.
5. **Operational verification:** deploy to gw2 first. Watch:
   `bundle_repair_pending_bundles{instance="turbo-gw-fsn1-2"}` should
   start declining at a meaningful rate (vs current ~1.5%/day). If the
   unbundler queue saturates, the existing skip metric tells us. If
   data-source upstreams 404 for the parent L1, we see those in
   `GatewaysDataSource` logs.
6. **Out-of-scope follow-ups filed** as separate issues (or sections
   in the broader bundle-pipeline-roadmap doc).
