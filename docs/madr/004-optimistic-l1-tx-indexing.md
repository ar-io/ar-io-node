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
(b) stable.**

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

### Serving guard — never `verified` until stable

This is the load-bearing decision. An optimistically-indexed tx supplies its own
`data_root`; if its (poster-supplied) bytes are also present, the
data-verification worker would find the indexed and computed data roots equal
and stamp the data `verified` — **even though merkle self-consistency is not
permanence**. So:

> The data-verification worker withholds the `verified` stamp until the root tx
> is **stable** (past `MAX_FORK_DEPTH`).

We gate on **(b) stable**, not (a) mined, deliberately:

- It matches the existing precedent for "treat as permanent": the response layer
  already gates `Cache-Control: immutable` on the same `stable` flag. We must
  never stamp `verified` on data we would not yet cache as `immutable`.
- It closes the mined-then-reorged residual for free (a stable tx cannot reorg
  out), whereas gating at mine would leave a window.
- It requires no new DB method — `stable` is already returned by
  `getDataAttributes`, which the worker already calls.

The guard is **always on** (independent of the feature flag): normal mined txs
arrive from blocks already stable, so it is a no-op for them; it only ever
withholds not-yet-stable data. Withholding does not consume the verification
retry budget, so a legitimately pending tx verifies on the first sweep after it
stabilizes.

### Scope

This decision ships **Scope 1**: optimistic indexing + the serving guard.
Pre-mine *byte serving* of `/raw/<id>` from the chunk cache is **deferred**
(Scope 2) — it would move the exposure onto the serving hot path and should land
only after the guard has soaked. The bundler-supplied data-item offset
refinement is likewise deferred.

## Consequences

- **Positive:** completes the optimistic triad; the integrity invariant is
  enforced by construction (and verified live: an optimistically-indexed tx with
  byte-correct data is *not* marked verified until stable); minimal footprint
  (no new tables/DB methods); reorg-safe; off by default; the always-on guard
  also slightly *reduces* the pre-existing verify-at-mine reorg exposure.
- **Negative / residual:** a reorg deeper than `MAX_FORK_DEPTH` of an
  already-verified tx would leave a stale `verified` flag — astronomically rare,
  pre-existing for any verified tx, and not worsened here. Verification of
  not-yet-stable data is delayed to stabilization; in practice negligible since
  verification runs as a background sweep over a backlog already past stable.
- **Operational:** trusted posters only; never-mined rows are bounded by
  `OPTIMISTIC_TX_MAX_BATCH_SIZE` and reclaimed within
  `OPTIMISTIC_TX_CLEANUP_WAIT_SECONDS`.

[David]: https://github.com/djwhitt
[vilenarios]: https://github.com/vilenarios
