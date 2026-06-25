# ClickHouse GQL `TOO_MANY_ROWS` on owner-filtered queries

**Date:** 2026-06-25
**Status:** Investigation complete; fix proposed, not yet implemented
**Measured on:** canary gateway (gw1), ClickHouse 26.3.9, `default.transactions`
(501.8M rows, 135 GiB data + 67 GiB `owner_projection`, 92 active parts)

## Summary

Owner-filtered GraphQL `transactions` queries — the dominant ArDrive access
pattern — fail with ClickHouse `Code: 158 TOO_MANY_ROWS` (the gateway's
`CLICKHOUSE_GQL_MAX_ROWS_TO_READ = 10,000,000` per-query guardrail) even for
owners with a tiny footprint. The cause is structural: the `transactions` table
is **height-ordered**, but these queries filter on `owner_address`, whose rows
are scattered thinly across the whole height range. Reading enough granules to
satisfy the filter blows past 10M rows.

The materialized `owner_projection` stores the same data owner-ordered but
**ClickHouse cannot use it for this query shape** — it serves the filter but is
abandoned the moment `ORDER BY … LIMIT` is present. The robust fix is a
dedicated **owner-ordered table** the gateway routes to when an `owners` filter
is present.

## The triggering query

`UserDriveEntities` — "list this user's drives":

```graphql
query UserDriveEntities($owner: String!, $after: String) {
  transactions(
    first: 100, after: $after, sort: HEIGHT_DESC,
    tags: [{name: "Entity-Type", values: ["drive"]}],
    owners: [$owner]
  ) { edges { node { ...TransactionCommon } cursor } pageInfo { hasNextPage } }
}
```

Three properties make it pathological — none of them "wide block range":

1. **owner + tag combined.** The tag presence sets `optimize_use_projections = 0`
   in `buildChTransactionsSql` (`composite-clickhouse.ts`), and the optimizer
   wouldn't use the projection here anyway (see below). The query falls back to
   the height-ordered main table, finding the owner via `owner_address_bloom`.
2. **Small answer, huge candidate scan.** The owner filter matches every item
   that owner ever uploaded; the selective `Entity-Type=drive` only narrows
   *after* the read. "Entity-Type" is on every ArDrive entity, so the tag blooms
   prune almost nothing.
3. **Sub-`pageSize` result forces exhaustion.** With fewer than 100 drives, the
   query can never fill the page and early-terminate; to return the page *and*
   prove `hasNextPage: false` it must scan the owner's entire height span.

## Measurements

All on the real owner `6Z-ifqgVi1jOwMvSNwKWs6ewUEQ0gU9eo4aHYC3rN1M`
(`owner_address` = `unhex('e99fa27ea8158b58cec0cbd2370296b3a7b0504434814f5ea38687602deb3753')`),
tags `Entity-Type` = `unhex('456e746974792d54797065')`, `drive` =
`unhex('6472697665')`.

| # | What | Result |
|---|------|--------|
| Q1 | `EXPLAIN ESTIMATE` of the failing query (projections off) | **12,148,697 rows / 1486 granules** → over the 10M cap |
| Q2 | Owner's total footprint `count()` | **22,064 rows** |
| Q3 | The actual answer size (drive count) | **46 rows** |
| Q4 | `owner_projection` materialized? | yes, all 94 parts, 501.8M rows |
| Q7 | Owner-ONLY estimate on main table | **22,451,872 rows / 2746 granules** to find 22k rows |
| Q8 | Owner height spread | heights 737,838 → 1,946,014 = **1.2M-block span, 13 partitions** |
| Q9 | Pure owner seek via projection (forced) | **581,784 rows / 73 granules** — projection usable |
| Q5 | owner + tag + `ORDER BY/LIMIT`, projection forced | ❌ `PROJECTION_NOT_USED` |
| Q12 | owner + tag, **no order/limit**, projection forced | ✅ **442,988 rows / 55 granules** |
| Q13 | subquery (filter inner, order/limit outer) | 12,148,697 rows — limit pushed down, projection abandoned |
| Q14 | Q13 with projection forced | ❌ `PROJECTION_NOT_USED` |
| Q10 | main table data size | 135.45 GiB |
| Q11 | `owner_projection` data size | 67.14 GiB |

### Interpretation

- **It's real scatter, not bloom false positives.** The owner has 22k rows but
  they live in ~2746 distinct height-ordered granules (~8 owner rows per 8192-row
  granule) because the owner uploaded in bursts across a 1.2M-block span (Q7+Q8).
  Reading those granules = 22.5M rows. Tightening `owner_address_bloom` (e.g.
  0.01 → 0.001) would only remove the ~1% genuine false positives, leaving
  ~2200 real granules ≈ 18M rows — still over the cap. **Bloom tuning is dead.**
- **The projection works for filtering but not for top-N.** Q9 (pure owner) and
  Q12 (owner+tag, no order/limit) both use the projection and read <600k rows.
  Q5 (add `ORDER BY … LIMIT`) returns `PROJECTION_NOT_USED`. ClickHouse normal
  projections do not support `optimize_read_in_order`, so once a top-N
  `ORDER BY … LIMIT` is present the optimizer reverts to the base table's
  primary key (height) and uses skip indexes for the owner — back to 12M rows.
- **You can't trick it from SQL.** Wrapping the filter in a subquery (Q13/Q14)
  doesn't help: ClickHouse pushes the `ORDER BY/LIMIT` down into the inner read
  and abandons the projection again.

## Why the projection fails but a separate table works

This is the crux. The `owner_projection` *is* a complete owner-ordered copy of
the data (67 GiB, maintained on every insert). The problem is purely that the
**optimizer won't route a top-N query to it**:

- A normal projection is only ever used if ClickHouse's projection analysis
  *chooses* it. That analysis can substitute a projection for **filtering** and
  **aggregation**, but it does **not** use a normal projection's sort order to
  satisfy `ORDER BY … LIMIT` with early termination (`optimize_read_in_order`).
  When the top-N is present, the optimizer falls back to reading the base table
  in primary-key (height) order and applies the owner filter via skip indexes —
  the 12M-row path. There is no SQL-level rewrite that reliably forces it
  (Q13/Q14).

A dedicated **table** removes the optimizer from the decision entirely:

- `SELECT … FROM transactions_by_owner WHERE owner_address = X ORDER BY height DESC LIMIT 101`
- Here `owner_address` is the literal **primary-key prefix**, so `WHERE owner = X`
  is an ordinary primary-key range seek — always available, not a heuristic.
- `ORDER BY height DESC` matches the table's own sort-key suffix
  `(owner_address, height, …)`, so `optimize_read_in_order` applies on a **real
  primary key** (fully supported): ClickHouse reads the owner's rows already in
  height order and early-terminates at `LIMIT`.

In short: the projection only gets used for the *filter half* and is abandoned
for the *order/limit half*; a table makes `owner_address` a first-class primary
key so both halves are native. The two orderings (by-height for the common case,
by-owner for this case) are inherently two physical copies — which is exactly
what the projection already is; we're just moving that copy into a form the
gateway can address directly.

## Update: `optimize_read_in_order = 0` reuses the existing projection (cheapest fix)

Follow-up measurement (same owner): the projection is "inapplicable" with
`ORDER BY … LIMIT` *only because read-in-order is enabled*. Disabling it
per-query unlocks the projection — and the optimizer picks it **without forcing**:

| # | What | Result |
|---|------|--------|
| H1 | owner+tag+ORDER BY+LIMIT, `optimize_read_in_order=0`, projection **forced** | ✅ applicable, **451,180 rows / 56 granules** |
| H2 | same, **not forced** (optimizer's natural choice) | ✅ **451,180 rows / 56 granules** |

So the cheapest fix is a **pure emitted-SQL change** in `buildChTransactionsSql`:
for owner-filtered queries, emit
`SETTINGS optimize_use_projections = 1, optimize_read_in_order = 0`
(today tags force `optimize_use_projections = 0`; this path must set it to 1).
Reads drop **12.1M → 451K** (27× under the cap), reusing the 67 GiB projection
already on disk. No new table, no backfill.

**Caveat — re-sort per page.** With read-in-order off, ClickHouse sorts the full
matched set before applying `LIMIT`, and does so on *every* page (no early
termination). For small/selective owner queries (a user's few drives/folders —
the dominant ArDrive landing queries) the matched set is tiny and this is free.
For owner+`file` deep pagination over a heavy owner, it re-reads and re-sorts the
whole footprint per page (O(n) per page). Those cases want the owner-result
cache and/or the dedicated owner-ordered table below (which gets *native*
read-in-order, no re-sort).

## Implementation (shipped, env-gated off by default)

The cheapest fix — reuse the existing `owner_projection` via
`optimize_read_in_order = 0` — is implemented in `composite-clickhouse.ts`
behind a feature flag, no schema change. A dedicated owner-ordered table
(below) is **deferred** as a future option for heavy-owner deep pagination.

1. **Projection routing (hacks 1 + 4).** In `buildChTransactionsSql`, eligible
   owner-filtered queries emit
   `SETTINGS optimize_use_projections = 1, optimize_read_in_order = 0` so the
   optimizer seeks `owner_projection` and sorts the small matched set in memory
   (12.1M → 451K rows for the example owner). Otherwise the existing
   `optimize_use_projections = 0` (id/tag lookups) is preserved unchanged.
2. **Eligibility predicate (`ownerProjectionApplies`).** A query qualifies only
   when the feature is enabled, `owners` is present, `ids` is absent, and the
   query carries an `Entity-Type` tag filter whose values are **all** in a
   configurable allowlist (`CLICKHOUSE_GQL_OWNER_PROJECTION_ENTITY_TYPES`,
   default `drive,folder,snapshot`). This deliberately **excludes
   `Entity-Type=file`** (millions of rows per owner → an expensive full sort of
   the matched set, re-done every page because read-in-order is off), as well as
   bare-owner and owner+other-tag queries. Those keep planning as today.
3. **Reactive windowing fallback (hack 5).** When an *eligible* query still
   trips `max_rows_to_read` (a whale whose footprint exceeds the cap even via
   the projection), the stable leg catches Code 158 and retries via
   `queryStableTransactionsWindowed` — an adaptive height-window walk (halves
   the span on repeated 158, caps at 256 windows) accumulating `pageSize + 1`
   rows so the existing merge / `hasNextPage` logic is untouched.
4. **Master gate.** Everything is off unless
   `CLICKHOUSE_GQL_OWNER_PROJECTION_ROUTING_ENABLED=true`. When off, behavior is
   byte-identical to before. Window-span tuning lives in module-level
   `OWNER_WINDOW_*` constants (promote to env config if operators need them).

Not yet validated against production: the windowing fallback's real trigger (a
whale exceeding 10M rows through the projection) and multi-page cursor
pagination under `optimize_read_in_order = 0` (see "cursor pagination check").

### Deferred: dedicated owner-ordered table

Justified only if heavy-owner `file` deep pagination shows up hot in profiling
(the projection path re-sorts the matched set per page; a real table gets
*native* read-in-order). Sketch:

1. **`transactions_by_owner`**, same columns,
   `ENGINE = ReplacingMergeTree(inserted_at)`,
   `ORDER BY (owner_address, height, block_transaction_index, is_data_item, id)`,
   partitioned `intDiv(height, 100000)`. No skip indexes — owner is the PK prefix.
2. **Keep it in sync** with a `MATERIALIZED VIEW … TO transactions_by_owner` on
   inserts, *or* an explicit second write in the import pipeline. **Verify the
   import path uses `INSERT`** (not `ATTACH PARTITION` / other DDL that bypasses
   MV triggers) — check the auto-import flow and
   `gateway-control.ts cleanClickHouseTables` staging/final handling.
3. **Route** owner queries to it (PK-prefix seek + native read-in-order, no
   re-sort), then **drop `owner_projection`** to offset its ~67 GiB / write /
   merge cost.

## Overhead

**Key framing:** the owner-ordered copy already exists as the 67 GiB
`owner_projection`, maintained on every insert. Replacing it with a table is
largely a *restructuring of existing overhead*, not new overhead.

### One-time creation window (the only real new cost)

- Backfill `INSERT INTO transactions_by_owner SELECT * FROM transactions` for
  501.8M rows = a full re-sort from height-order to owner-order. Reads 135 GiB,
  writes ~67 GiB, external-sorts (spills to temp disk), then background-merges
  the resulting parts.
- On production hardware competing with live import + queries: expect heavy CPU
  (the sort), heavy disk IO, and merge churn — order of tens of minutes to a few
  hours. **Mitigate:** batch by height partition
  (`… WHERE height >= a AND height < b`), throttle `max_threads` /
  `max_bytes_before_external_sort`, run off-peak, and create the table + MV
  *before* backfilling (ReplacingMergeTree dedups any overlap with rows arriving
  during the backfill).
- Transient storage peak: ~+67 GiB while both the new table and the
  still-present projection exist (drop the projection only after cutover).

### Ongoing (≈ neutral if the projection is dropped)

- **Writes:** every import block written to a second table ≈ the per-insert
  projection maintenance happening today. Net ~neutral after dropping the
  projection.
- **Merges:** a second table's background merges ≈ today's projection merges.
  Net ~neutral.
- **Storage:** +~67 GiB table − ~67 GiB projection ≈ neutral.
- **Query:** owner-filtered GQL drops from ~12M to <600k rows read (and far less
  after merges, approaching the owner's true ~3-granule footprint); non-owner
  queries are unchanged.

## Appendix: byte encodings (for reproducing the queries)

- `owner_address = unhex(b64UrlToHex(owner))` — base64url-decode the GQL owner
  to 32 bytes, hex-encode.
- Tag name/value = `Buffer.from(str).toString('hex')` (UTF-8), e.g.
  `Entity-Type` → `456e746974792d54797065`, `drive` → `6472697665`.
- Run inside the CH container:
  `sudo docker exec -i ar-io-node-indexer-clickhouse-1 sh -c
  'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --multiquery'`.
