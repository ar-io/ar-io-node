# Optimistic L1 Transaction Indexing

- Status: proposed
- Deciders: [David], [vilenarios]
- Date: 2026-06-18
- Authors: [David]

## Context and Problem Statement

Posting data through a gateway should make it immediately usable. The gateway
already supports two "optimistic" surfaces: a poster's bundle **bytes** can be
cached on `POST /chunk` (the optimistic chunk ingest cache), and individual
ANS-104 **data items** can be made queryable before they mine
(`/ar-io/admin/queue-data-item`). The missing third corner is the **L1
transaction itself**: until a bundle/tx is indexed, its `id → data_root`
mapping is unknown, so neither GraphQL nor the data path can resolve it. Today a
tx only becomes resolvable after it mines and the block importer indexes it.

We want an allowlisted bundler to make a **signed L1 transaction resolvable
before it mines** — completing the "post → instantly usable" pattern — without
ever compromising the gateway's core integrity promise:

> The gateway must never serve not-permanent data as permanent.

This is harder than the chunk cache. A junk chunk is *unaddressable* (it can
only be reached by an on-chain absolute offset that a never-mined tx lacks), so
open ingest was safe there. An optimistically-indexed L1 tx is the opposite: it
is **immediately queryable** (`transaction(id)`, the `/raw,/:id` data path), so
a phantom or premature-"verified" tx would be directly visible.

## Decision Drivers

- **Integrity (non-negotiable):** an optimistically-indexed tx (or its data)
  must never be served as `verified`/permanent until it is confirmed on-chain,
  and a tx that never mines must be reclaimed.
- **Trust model:** an indexed tx is visible/queryable, so ingest must be
  trusted-only (admin/allowlist), and every tx must be authentic.
- **Minimal new surface / reuse:** prefer the existing transaction lifecycle
  over a parallel optimistic-state machine.
- **Off by default:** opt-in per operator.

## Considered Options

1. **A dedicated optimistic-tx ledger** (a new table tracking pending tx state +
   a `confirmed_at` column and a confirmation subscriber), mirroring the chunk
   ingest cache's `chunks.db`.
2. **Ride the existing `new_transactions` lifecycle**, where a row with
   `height IS NULL` already *is* an optimistic (pending) transaction.

For the serving guard specifically, the bar for "confirmed enough to serve as
permanent" could be:

- **(a) mined** — `new_transactions.height IS NOT NULL`; or
- **(b) stable** — present in `stable_transactions` (past `MAX_FORK_DEPTH`).

## Decision Outcome

**Chosen: option 2 (ride `new_transactions`), with the serving guard gating on
(a) mined.**

### Indexing — reuse the transaction lifecycle

A new admin endpoint, `POST /ar-io/admin/queue-optimistic-tx`, accepts standard
signed Arweave L1 transaction headers and inserts each via the existing `saveTx`
path, producing a `new_transactions` row with `height IS NULL`. The lifecycle
then handles everything with no new state:

- **Visible immediately** — GraphQL `transaction(id)` already falls through to
  `new_transactions` and returns the row with `block: null` (the honest
  "unmined" signal). `saveTx` also writes the owner wallet row GraphQL requires.
- **Promoted in place when it mines** — `upsertNewTransaction` is
  `ON CONFLICT DO UPDATE SET height = IFNULL(@height, height)`, so the normal
  block-import path fills in the height. No confirmation subscriber is needed.
- **Reclaimed if it never mines** — the existing stale-new-data GC
  (`deleteStaleNewTransactions`) already deletes NULL-height rows past a leash;
  that leash is now configurable via `OPTIMISTIC_TX_CLEANUP_WAIT_SECONDS`.
- **Reorg-safe** — `resetToHeight` NULLs heights rather than deleting, so a
  forked-out tx returns to pending and re-enters the leash.

This means **no new tables and no new DB methods** — the optimistic index is an
existing concept (a pending transaction), not a new subsystem.

### Trust model — authenticated, admin-only

The endpoint is gated by the existing `/ar-io/admin` bearer auth (the
"allowlist") and a master switch, `OPTIMISTIC_TX_INDEXING_ENABLED` (default
**off** → `403`). Every submitted tx is cryptographically verified
(`arweave.transactions.verify`): the `id` must bind to the signature and the
signature must verify against the owner. Because `data_root` (and every other
consequential field) is inside the Arweave signed structure, a poster **cannot**
submit a real id pointing at a forged `data_root`, nor index another signer's
tx. A batch-size cap (`OPTIMISTIC_TX_MAX_BATCH_SIZE`, default 100) bounds the
sequential verification work a single request can schedule.

### Serving guard — never `verified` while unmined

This is the load-bearing decision. An optimistically-indexed tx supplies its own
`data_root`; if its (poster-supplied) bytes are also present, the
data-verification worker would find the indexed and computed data roots equal
and stamp the data `verified` — **even though merkle self-consistency is not the
same as having an on-chain block**. So:

> The data-verification worker withholds the `verified` stamp while the root tx
> is **unmined** (`height IS NULL` — no block yet).

We gate on **(a) mined**, not (b) stable, deliberately:

- It enforces the invariant *exactly*. The integrity requirement is "never mark
  `verified` a tx that has no on-chain block yet" — which is precisely the
  optimistic `height IS NULL` state this feature creates. `stable` (past fork
  depth) is a stronger, different property.
- `verified` (data-integrity) and `stable` (inclusion-permanence) are **separate
  trust signals** with separate response headers; gating `verified` on `stable`
  conflates them and over-reaches.
- It is **scoped to optimistic/unmined data** — normal mined data keeps its
  status-quo verify-at-mined timing, so there is **zero impact** on normal data
  (feature on or off), and any recompute is confined to optimistic data. Gating
  on `stable` would instead delay verification for *all* recently-mined data
  gateway-wide.

The check is **always on** but, because it only fires for unmined rows, it is a
true no-op for normal mined data. It runs **before** the data-root computation,
so an unmined item is skipped cheaply rather than having its data root recomputed
on every sweep until it mines, and withholding does not consume the verification
retry budget — the item verifies on the first sweep after it mines. The minimal
DB addition is a `height` field on `getDataAttributes` (already fetched by the
worker).

Trade-off accepted: a tx that is mined but then reorged out (a fork shallower
than `MAX_FORK_DEPTH`) could be momentarily verified-then-unmined. This is the
*pre-existing* verify-at-mine behavior for all data — corner C neither
introduces nor worsens it — and `resetToHeight` returns such a row to
`height IS NULL`, re-arming this guard.

### Scope

This decision ships **Scope 1**: optimistic indexing + the serving guard.
Pre-mine *byte serving* of `/raw/<id>` from the chunk cache is **deferred**
(Scope 2) — it would move the exposure onto the serving hot path and should land
only after the guard has soaked. The bundler-supplied data-item offset
refinement is likewise deferred.

## Consequences

- **Positive:** completes the optimistic triad; the integrity invariant is
  enforced *exactly* (verified live: an optimistically-indexed tx with
  byte-correct data is *not* marked verified while unmined); **zero impact on
  normal mined data** — verification timing and trust headers are unchanged for
  everything except optimistic txs; minimal footprint (one `height` field added
  to `getDataAttributes`, no new tables/DB methods); off by default.
- **Negative / residual:** (1) the mined-then-reorged window (above) — pre-existing
  for all data, not worsened. (2) Unmined items are not yet gated out of the
  verification SELECT, so they occupy the `LIMIT 1000` batch and (keeping
  `retry_count=0`) sort first; under high unmined volume they could crowd out
  mined verifiable data. Bounded in practice (only optimistic txs with cached
  data reach the worker; admin-rate-limited + GC'd; for Scope 1 there is no
  pre-mine byte path so they have no `contiguous_data_ids` row at all) and
  observable via `optimistic_tx_verification_blocked_total` — measure before
  gating the SELECT on mined-status.
- **Operational:** trusted posters only; never-mined rows are bounded by
  `OPTIMISTIC_TX_MAX_BATCH_SIZE` and reclaimed within
  `OPTIMISTIC_TX_CLEANUP_WAIT_SECONDS`.

[David]: https://github.com/djwhitt
[vilenarios]: https://github.com/vilenarios
