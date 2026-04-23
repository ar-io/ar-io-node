# ClickHouse Schema and Query Optimizations

This document is a developer reference for the ClickHouse schema used by
ar-io-node's batch layer and the query-level optimizations layered on top
of it. It complements two sibling docs:

- [ClickHouse Pipeline Architecture](clickhouse-pipeline.md) — how data
  flows from SQLite through Parquet into ClickHouse, and how GraphQL
  requests are routed across backends.
- [Parquet and ClickHouse Usage](parquet-and-clickhouse-usage.md) —
  operator-facing setup, TTL rules, and upgrade paths.

The schema lives in `src/database/clickhouse/schema.sql` and
`src/database/clickhouse/ttl-schema.sql`. The GraphQL query builder lives
in `src/database/composite-clickhouse.ts`. The migrate query that lands
data in the final table lives in `scripts/clickhouse-import`.

## Design goals

The final `transactions` table is tuned for the GraphQL transactions query
mix: paginated listings filtered by some combination of `ids`, `owners`,
`recipients` (`target`), `tags`, and height range, ordered by
`(height, block_transaction_index, is_data_item, id)`. The overriding
constraints:

- **Every predicate a GraphQL query can express must be servable in
  sub-second time without a full table scan.** Each supported filter has
  either a primary-key match, a skip index, or a projection behind it.
- **Pagination must early-terminate.** A client fetching the first page
  should not read the entire table. The query shape is structured so
  ClickHouse's read-in-order optimization kicks in.
- **Duplicates from re-imports must collapse silently.** Partition
  re-imports are idempotent via `ReplacingMergeTree`, and the query
  layer tolerates the transient pre-merge state.

## Table layout

### Staging tables

`staging_blocks`, `staging_transactions`, and `staging_tags` are
`ReplacingMergeTree` tables that hold exactly one height-partition's
worth of Parquet data at a time. `scripts/clickhouse-import` COPYs
Parquet files into these tables, then `migrate_staging_to_final` joins
the three together, applies TTL rules, and inserts the result into the
final `transactions` table. After a successful migrate, staging is
truncated. These tables intentionally mirror the Parquet column types
and carry no indexes or projections — they're short-lived staging
scratch space.

### Final table: `transactions`

```sql
CREATE TABLE transactions (
  height UInt32 CODEC(Delta(4), LZ4),
  block_transaction_index UInt16 CODEC(Delta(2), LZ4),
  is_data_item Boolean,
  id BLOB,
  ...
  tags Array(Tuple(BLOB, BLOB)),
  tags_count UInt32,
  expires_at Nullable(DateTime),
  tag_names Array(BLOB) MATERIALIZED arrayMap(x -> x.1, tags),
  tag_values Array(BLOB) MATERIALIZED arrayMap(x -> x.2, tags),
  INDEX id_bloom (id) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX target_bloom (target) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX owner_address_bloom (owner_address) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX tag_names_bloom tag_names TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX tag_values_bloom tag_values TYPE bloom_filter(0.01) GRANULARITY 4,
  PROJECTION owner_projection (
    SELECT *, tag_names, tag_values
    ORDER BY (owner_address, height, block_transaction_index, is_data_item, id)
  ),
  PRIMARY KEY (height, block_transaction_index, is_data_item, id)
) Engine = ReplacingMergeTree(inserted_at)
PARTITION BY intDiv(height, 100000)
ORDER BY (height, block_transaction_index, is_data_item, id)
TTL ifNull(expires_at, toDateTime(0)) DELETE WHERE expires_at IS NOT NULL
SETTINGS deduplicate_merge_projection_mode = 'rebuild';
```

Each piece is load-bearing for a specific query shape; the sections
below unpack why.

## Primary key and partitioning

### `ORDER BY (height, block_transaction_index, is_data_item, id)`

This ordering is chosen to match the GraphQL pagination order exactly.
Consequences:

- **Range scans are sequential.** A height-bounded listing reads adjacent
  granules, not a scatter of marks across the table.
- **Cursors translate directly to a tuple comparison.** Every GraphQL
  cursor encodes `(height, block_transaction_index, is_data_item, id)`,
  and "the next page" is literally a predicate in PK order — no external
  state required.
- **Early termination works.** Because the requested order matches the
  stored order, `ORDER BY pk LIMIT N` short-circuits as soon as N rows
  are emitted. The GraphQL query builder relies on this; see
  [Inner LIMIT trick](#inner-limit-trick) below.

### `PARTITION BY intDiv(height, 100000)`

Partitioning by height buckets of 100 000 lets the planner skip entire
partitions when a query has a bounded height range — either from an
explicit `minHeight` / `maxHeight`, or from a cursor whose `height`
predicate collapses the search space. The bucket size is a trade-off:

- Too small → lots of partitions, more metadata, slower merges.
- Too large → partition pruning has little to bite on, recent partitions
  dominate the working set.

100 000 blocks is roughly 50 days of Arweave chain time, which keeps
the partition count in the dozens for the current chain length while
still letting recent-data queries skip the bulk of the table.

### Cursor predicate split

A cursor predicate of the form
`(height, block_transaction_index, is_data_item, id) < (...)` is *not*
decomposed by ClickHouse's partition pruner — the tuple comparison is
opaque to it. The GraphQL query builder adds a standalone
`height <= cursor.height` predicate alongside the tuple comparison so
partition pruning still kicks in. Both predicates are always correct;
the redundancy exists solely to feed the pruner.

See `addGqlTransactionFilters` in
`src/database/composite-clickhouse.ts:292-401`.

## Column-level optimizations

### Codecs

- `Delta + LZ4` on `height` and `block_transaction_index`: both are
  near-monotonic within a partition, so delta encoding collapses them
  into near-zero deltas before LZ4 runs.
- `Delta + ZSTD(1)` on timestamp columns (`block_timestamp`,
  `indexed_at`, `inserted_at`): same reasoning, with ZSTD trading a
  little CPU for tighter compression on the slower-moving timestamp
  values.
- `ZSTD(3)` on `anchor` and `owner` (the full RSA modulus, not the
  hashed address): these are the largest fixed fields and compress
  well under heavier ZSTD. They're also rarely part of filter
  predicates, so the decompression cost is paid only when explicitly
  selected.

### `LowCardinality(String)` on `content_type`

Content types cluster into a few dozen distinct values across the
whole chain. `LowCardinality` stores a dictionary per part and emits
small integer codes for the actual rows, both shrinking storage and
speeding up equality filters.

### Materialized `tag_names` / `tag_values`

The canonical `tags` column is `Array(Tuple(BLOB, BLOB))`, which is
the shape GraphQL consumers want. But ClickHouse bloom-filter skip
indexes match reliably against column references and *not* against
lambda expressions — an index over `arrayMap(x -> x.1, tags)` is a
no-op at query time. Two `MATERIALIZED` columns project the name and
value arrays out of the tuples:

```sql
tag_names  Array(BLOB) MATERIALIZED arrayMap(x -> x.1, tags),
tag_values Array(BLOB) MATERIALIZED arrayMap(x -> x.2, tags),
```

The `tag_names_bloom` / `tag_values_bloom` skip indexes then index these
columns directly, so queries like `has(tag_names, ...)` and
`hasAny(tag_values, ...)` can prune granules.

`MATERIALIZED` columns are excluded from `SELECT *`, which matters for
the projection body — see [owner_projection](#owner_projection) below.

## Skip indexes

All five skip indexes use `bloom_filter(0.01)` — a 1 % false-positive
rate, which is the ClickHouse default sweet spot. At 1 %, each granule
bitmap is small enough that carrying them for five columns costs little
storage, while still eliminating ~99 % of granules for a miss.

| Index                 | Column         | Granularity | Purpose                                              |
|-----------------------|----------------|-------------|------------------------------------------------------|
| `id_bloom`            | `id`           | 1           | Point lookups (`transactions(ids: [...])`)           |
| `target_bloom`        | `target`       | 1           | Recipient filter                                     |
| `owner_address_bloom` | `owner_address`| 1           | Owner filter on the main table (see below)           |
| `tag_names_bloom`     | `tag_names`    | 4           | `has(tag_names, ...)`                                |
| `tag_values_bloom`    | `tag_values`   | 4           | `hasAny(tag_values, ...)`                            |

`GRANULARITY 1` means one bitmap per index granule (a single mark). Tag
arrays benefit from `GRANULARITY 4` — each tag-array value contains
multiple elements, so the combined bitmap over four marks is still
selective and uses less space.

### Why both `owner_address_bloom` and `owner_projection`?

`owner_projection` is the preferred access path for large owner-filtered
listings — it sorts the whole table by `owner_address` first, turning
the query into a sequential range scan. But projections don't support
inline skip indexes (ClickHouse's grammar rejects `INDEX` inside a
`PROJECTION` body), so any query that needs skip-index pruning must
run against the main table. `owner_address_bloom` exists so that tag-
filtered or id-filtered queries that *also* constrain the owner can
still prune granules on the main table after `optimize_use_projections`
is disabled for those queries.

## Projections

### `owner_projection`

```sql
PROJECTION owner_projection (
  SELECT *, tag_names, tag_values
  ORDER BY (owner_address, height, block_transaction_index, is_data_item, id)
)
```

This is a second physical copy of the data sorted by
`owner_address` first. An owner-filtered listing reads it as a
sequential range scan instead of a random-access hunt through the
base table's height-sorted layout.

Two subtleties:

- **`SELECT *, tag_names, tag_values` — not just `SELECT *`.** Because
  `tag_names` and `tag_values` are `MATERIALIZED`, `SELECT *` excludes
  them from the projection body. Without that explicit listing, the
  optimizer cannot serve tag-filtered *and* owner-filtered queries from
  the projection — it would have to fall back to the main table for
  tag predicates. Existing deployments from before this fix need the
  one-time `MATERIALIZE PROJECTION` rebuild documented in
  [In-place upgrade](parquet-and-clickhouse-usage.md#in-place-upgrade).
- **`deduplicate_merge_projection_mode = 'rebuild'`.** Projections on
  `ReplacingMergeTree` are production-safe from ClickHouse 24.8. This
  setting tells the engine to rebuild the projection from scratch when
  a merge needs to deduplicate, rather than attempting an in-place
  patch that could leave the projection inconsistent.

## `ReplacingMergeTree` deduplication

The final table uses `ReplacingMergeTree(inserted_at)` so that partition
re-imports are idempotent. When the same primary key arrives twice, the
row with the larger `inserted_at` wins on the next background merge.

There are **no manual `OPTIMIZE TABLE` triggers** — the system relies on
ClickHouse's background merge scheduler. Until a merge happens, reads can
see both versions, and queries must either use `FINAL` (heavy) or do
query-time dedupe. The GraphQL query layer chooses query-time dedupe;
see [`LIMIT 1 BY`](#limit-1-by-dedupe) below.

## TTL

```sql
TTL ifNull(expires_at, toDateTime(0)) DELETE WHERE expires_at IS NOT NULL
```

`expires_at` is computed at insert time by `migrate_staging_to_final`
from the operator's TTL rules (see
[Tag-based TTL Rules](parquet-and-clickhouse-usage.md#tag-based-ttl-rules)).
The TTL clause then lets the engine drop rows on background merge
without any external scheduling. The `IS NOT NULL` guard prevents
rows with `NULL` expiry from ever being eligible for deletion — the
`ifNull(..., toDateTime(0))` is only there to keep the expression
type-consistent.

## GraphQL query shape

The query builder in `src/database/composite-clickhouse.ts` wraps the
filtered `SELECT` in a subquery and applies a dedupe pass outside. The
query looks like:

```sql
SELECT *
FROM (
  SELECT ... FROM transactions AS t
  WHERE <filters>
  ORDER BY t.height DESC, t.block_transaction_index DESC, ..., t.id DESC
  LIMIT <innerLimit>
)
ORDER BY height DESC, block_transaction_index DESC, ..., id DESC
LIMIT 1 BY height, block_transaction_index, is_data_item, id
LIMIT <pageSize + 1>
SETTINGS <per-query settings>
```

Four separate things are happening here; each is load-bearing.

### Inner LIMIT trick

The inner `SELECT ... ORDER BY pk LIMIT N` is the shape that triggers
ClickHouse's read-in-order early termination: the planner short-circuits
as soon as N rows are emitted, instead of reading the full matching set.
Dropping the `LIMIT` or replacing the structure with a bare `LIMIT 1 BY`
(which is the natural way to write it) disables the optimization and
forces a full scan. Keeping dedupe *outside* the inner `LIMIT` preserves
the short-circuit.

### `LIMIT 1 BY` dedupe

The outer `LIMIT 1 BY height, block_transaction_index, is_data_item, id`
collapses any duplicate primary keys that the inner SELECT produced
before background merges got a chance to run. The companion `ORDER BY`
on the outer query pins a deterministic version to win across the
subquery boundary (ClickHouse doesn't guarantee subquery ordering
flows through otherwise).

### Dedupe headroom

The inner `LIMIT` is set to `(pageSize + 1) * CLICKHOUSE_GQL_DEDUPE_HEADROOM`
(default 4). The multiplier exists because `LIMIT 1 BY` runs *after* the
inner limit: if the inner window has more duplicates than expected, the
deduped result can come up short of `pageSize + 1` rows even when more
unique matches exist further on. 4× leaves comfortable headroom under
normal merge behavior (typically 1–2 versions per PK); operators can
raise `CLICKHOUSE_GQL_DEDUPE_HEADROOM` if they see short pages during
heavy ingest. See `src/config.ts:1434` for the full rationale.

### Per-query `SETTINGS`

Two settings are pinned per request:

```sql
SETTINGS max_rows_to_read = <CLICKHOUSE_GQL_MAX_ROWS_TO_READ>,
         optimize_use_projections = 0  -- only for id and tag lookups
```

- **`max_rows_to_read` (default 10 million).** A hard guardrail: any
  query whose planner estimate scans more than the threshold throws
  `Code: 158` instead of grinding through the whole table. This is a
  regression catcher — if a skip index is silently bypassed or a
  projection is shadowed, the query fails loudly instead of silently
  eating the CPU budget.
- **`optimize_use_projections = 0`** for queries with `ids` or `tags`
  filters. Projections don't support inline skip indexes, and the
  ClickHouse cost estimator compares mark counts *before* applying
  skip indexes. On raw size, `owner_projection` always wins, which
  forces a full projection scan and blocks the id / tag bloom filters
  from doing their job. Disabling projections for these queries routes
  them through the main table where the bloom filters can prune.

The net effect: owner-filtered queries get the projection; id- and
tag-filtered queries get the main-table skip indexes; height-only
queries get partition pruning and read-in-order termination. There's no
single access path that's best for all shapes, and the per-query
settings let each shape take its best path.

## Composite routing

`CompositeClickHouseDatabase` runs both the ClickHouse query and the
SQLite query in parallel and merges the results. Two optimizations
reduce the SQLite leg's workload:

- **Cached ClickHouse max-height boundary.** SQLite is queried only for
  heights above `(ch_max_height - CLICKHOUSE_SQLITE_MIN_HEIGHT_BUFFER)`
  when `CLICKHOUSE_SQLITE_MIN_HEIGHT_ENABLED` is true. The max-height
  lookup is cached for `CLICKHOUSE_MAX_HEIGHT_CACHE_TTL_SECONDS` (default
  60 s) so the boundary doesn't cost a round-trip per request. A cold
  cache falls back to "no optimization" — SQLite scans its full range
  and merge-time dedupe absorbs the overlap.
- **Circuit breaker on the SQLite leg.** An unhealthy or slow SQLite
  degrades to ClickHouse-only results with a `PARTIAL_RESULT` warning,
  rather than dragging the caller's request down to the breaker
  timeout. ClickHouse's own `max_execution_time` handles the reverse
  case (slow ClickHouse → error, not a partial).

See [ClickHouse Pipeline § GraphQL routing](clickhouse-pipeline.md#graphql-routing)
for the full routing flow and config knob reference.

## Related documents

| Document | Focus |
|----------|-------|
| [ClickHouse Pipeline Architecture](clickhouse-pipeline.md) | SQLite → Parquet → ClickHouse data flow, GraphQL routing |
| [Parquet and ClickHouse Usage](parquet-and-clickhouse-usage.md) | Operator guide: setup, TTL rules, upgrade, rollback |
| [MADR 001: ClickHouse GQL](madr/001-clickhouse-gql.md) | Rationale for picking ClickHouse as the batch-layer backend |
| [Environment Variables](envs.md) | `CLICKHOUSE_*` config reference |
| `src/database/clickhouse/schema.sql` | Authoritative table / index / projection definitions |
| `src/database/clickhouse/ttl-schema.sql` | TTL rule tables and dictionaries |
| `src/database/composite-clickhouse.ts` | GraphQL query builder and composite routing |
| `scripts/clickhouse-import` | `migrate_staging_to_final` and the TTL computation |
