CREATE TABLE IF NOT EXISTS staging_blocks (
  indep_hash BLOB,
  height UInt64 NOT NULL,
  previous_block BLOB,
  nonce BLOB NOT NULL,
  hash BLOB NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_count UInt32 NOT NULL,
  block_size UInt64,
  inserted_at DateTime DEFAULT now(),
  PRIMARY KEY (height)
) Engine = ReplacingMergeTree()
ORDER BY (height);

CREATE TABLE IF NOT EXISTS staging_transactions (
  id BLOB NOT NULL,
  indexed_at UInt32,
  block_transaction_index UInt16,
  is_data_item Boolean,
  target BLOB,
  quantity Decimal(20,0),
  reward Decimal(20,0),
  anchor BLOB NOT NULL,
  data_size UInt64,
  content_type String,
  format UInt8,
  height UInt64,
  owner_address BLOB,
  data_root BLOB,
  parent BLOB,
  "offset" UInt64,
  "size" UInt64,
  data_offset UInt64,
  owner_offset UInt64,
  owner_size UInt64,
  owner BLOB,
  signature_offset UInt64,
  signature_size UInt64,
  signature_type UInt8,
  root_transaction_id BLOB,
  root_parent_offset UInt64,
  inserted_at DateTime DEFAULT now(),
  PRIMARY KEY (height, block_transaction_index, is_data_item, id)
) Engine = ReplacingMergeTree()
ORDER BY (height, block_transaction_index, is_data_item, id);

CREATE TABLE IF NOT EXISTS staging_tags (
  height UInt32 NOT NULL,
  id BLOB NOT NULL,
  tag_index UInt16 NOT NULL,
  indexed_at UInt64,
  tag_name BLOB NOT NULL,
  tag_value BLOB NOT NULL,
  is_data_item BOOLEAN NOT NULL,
  inserted_at DateTime DEFAULT now(),
  PRIMARY KEY (height, id)
) Engine = ReplacingMergeTree()
ORDER BY (height, id, tag_index);

CREATE TABLE IF NOT EXISTS transactions (
  height UInt32 NOT NULL CODEC(Delta(4), LZ4),
  block_transaction_index UInt16 CODEC(Delta(2), LZ4),
  is_data_item Boolean,
  id BLOB NOT NULL,
  anchor BLOB NOT NULL CODEC(ZSTD(3)),
  owner_address BLOB,
  target BLOB,
  quantity Decimal(20,0) NOT NULL,
  reward Decimal(20,0) NOT NULL,
  data_size UInt64,
  content_type LowCardinality(String),
  format UInt8 NOT NULL,
  data_root BLOB,
  parent_id BLOB,
  block_indep_hash BLOB,
  block_timestamp UInt32 CODEC(Delta(4), ZSTD(1)),
  block_previous_block BLOB,
  indexed_at UInt64 CODEC(Delta(8), ZSTD(1)),
  inserted_at DateTime CODEC(Delta(4), ZSTD(1)),
  "offset" UInt64,
  "size" UInt64,
  data_offset UInt64,
  owner_offset UInt64,
  owner_size UInt64,
  owner BLOB CODEC(ZSTD(3)),
  signature_offset UInt64,
  signature_size UInt64,
  signature_type UInt8,
  root_transaction_id BLOB,
  root_parent_offset UInt64,
  tags Array(Tuple(BLOB, BLOB)),
  tags_count UInt32,
  -- Set by migrate_staging_to_final when an operator TTL rule matches this row.
  -- NULL means "retain indefinitely".
  expires_at Nullable(DateTime),
  -- Materialized columns for tag bloom filter indexing. Bloom filter skip
  -- indexes match reliably against column references but not against lambda
  -- expressions like arrayMap(x -> x.1, tags), so we project the names and
  -- values into their own columns and index those directly.
  tag_names Array(BLOB) MATERIALIZED arrayMap(x -> x.1, tags),
  tag_values Array(BLOB) MATERIALIZED arrayMap(x -> x.2, tags),
  INDEX id_bloom (id) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX target_bloom (target) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX owner_address_bloom (owner_address) TYPE bloom_filter(0.01) GRANULARITY 1,
  INDEX tag_names_bloom tag_names TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX tag_values_bloom tag_values TYPE bloom_filter(0.01) GRANULARITY 4,
  -- tag_names/tag_values are MATERIALIZED, so SELECT * excludes them. They
  -- must be listed explicitly or the optimizer cannot serve queries with
  -- tag_names/tag_values predicates from the projection.
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

-- Idempotent upgrade path for nodes that already have a transactions table
-- from before tag-based TTL rules were introduced. Safe to re-run; a no-op
-- once applied.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS expires_at Nullable(DateTime);
ALTER TABLE transactions MODIFY TTL ifNull(expires_at, toDateTime(0)) DELETE WHERE expires_at IS NOT NULL;

-- Idempotent add for the owner_address bloom skip index. New inserts get the
-- index for free, but existing parts need a one-time MATERIALIZE INDEX to
-- populate it (see manual migration block below). Safe to re-run.
ALTER TABLE transactions ADD INDEX IF NOT EXISTS owner_address_bloom (owner_address) TYPE bloom_filter(0.01) GRANULARITY 1;

-- One-time manual migration for nodes whose owner_projection was created with
-- the old `SELECT *` body (which excluded tag_names/tag_values, preventing
-- the optimizer from using the projection for tag-filtered queries). Not
-- run automatically because MATERIALIZE PROJECTION rewrites every part and
-- would re-trigger on each clickhouse-import cycle. Run once, per partition,
-- against an existing node:
--
--   ALTER TABLE transactions DROP PROJECTION IF EXISTS owner_projection;
--   ALTER TABLE transactions ADD PROJECTION owner_projection (
--     SELECT *, tag_names, tag_values
--     ORDER BY (owner_address, height, block_transaction_index, is_data_item, id)
--   );
--   ALTER TABLE transactions MATERIALIZE PROJECTION owner_projection;
--
-- Track progress via `SELECT * FROM system.mutations WHERE table='transactions'
-- AND NOT is_done`. Fresh deployments get the correct body from the CREATE
-- TABLE above and do not need this migration.

-- One-time manual migration to populate the owner_address bloom skip index on
-- existing parts. The ADD INDEX above registers the index so it's built for
-- new inserts, but old parts remain unindexed until MATERIALIZE INDEX rewrites
-- them. Not run automatically because MATERIALIZE INDEX rewrites every part
-- and would re-trigger on each clickhouse-import cycle. Run once against an
-- existing node:
--
--   ALTER TABLE transactions MATERIALIZE INDEX owner_address_bloom;
--
-- Track progress via `SELECT * FROM system.mutations WHERE table='transactions'
-- AND NOT is_done`.

-- =============================================================================
-- Id lookup: id -> primary-key prefix
-- =============================================================================
--
-- `transactions` is sorted by (height, block_transaction_index, is_data_item,
-- id), so finding rows by id alone relies on `id_bloom`. A 1% bloom filter
-- passes ~1% of all granules per looked-up id, so the cost of an id lookup
-- grows with the table: ~4M rows per id at ~400M rows, enough for 3 ids to
-- trip `max_rows_to_read`. `bundledIn` has no index at all and scans until
-- the cap stops it.
--
-- `transaction_ids` maps each id to its primary-key prefix. GraphQL resolves
-- `ids` (and `bundledIn` parent ids, whose items share the parent's height and
-- block_transaction_index) here first, then reads `transactions` by primary
-- key. A lookup reads about one granule per id, whatever the table size.
--
-- Deliberate choices (do not "fix"):
--   * A table, not a projection. Projections are stored per part, and
--     `transactions` is partitioned by height, so an id-ordered projection
--     still reads one granule per part per id. This table is unpartitioned and
--     merges into few parts.
--   * index_granularity = 1024: a point lookup reads one granule, so smaller
--     granules read fewer rows.
--   * No TTL. A lookup row must never be deleted while its `transactions`
--     row exists: GraphQL treats an id missing here as absent from ClickHouse
--     and would silently drop it from results. A TTL copied from `expires_at`
--     at insert time would do exactly that after any later
--     `ALTER TABLE transactions UPDATE expires_at` that extends retention
--     (the view only sees inserts). Rows outliving their `transactions` rows
--     (after expiry or a re-import) are harmless: the primary-key read then
--     finds nothing. `expires_at` is kept only because the view writes it.
--
-- Populated by `transaction_ids_mv` on every insert into `transactions`. Rows
-- already in `transactions` need a one-time backfill (see below); GraphQL only
-- uses this table when CLICKHOUSE_GQL_ID_LOOKUP_ENABLED=true, which should be
-- set after the backfill completes.
CREATE TABLE IF NOT EXISTS transaction_ids (
  id BLOB NOT NULL,
  height UInt32 NOT NULL,
  block_transaction_index UInt16,
  is_data_item Boolean,
  inserted_at DateTime,
  expires_at Nullable(DateTime)
) Engine = ReplacingMergeTree(inserted_at)
ORDER BY (id, height, block_transaction_index, is_data_item)
SETTINGS index_granularity = 1024;

CREATE MATERIALIZED VIEW IF NOT EXISTS transaction_ids_mv TO transaction_ids AS
SELECT id, height, block_transaction_index, is_data_item, inserted_at, expires_at
FROM transactions;

-- One-time manual backfill of `transaction_ids` for rows inserted into
-- `transactions` before the materialized view existed. Not run automatically
-- because it reads every row of `transactions` and would re-run on each
-- clickhouse-import cycle. Rows the view also inserts are deduplicated by the
-- ReplacingMergeTree, so it is safe to run while imports continue, and to
-- re-run. Run once against an existing node:
--
--   INSERT INTO transaction_ids
--   SELECT id, height, block_transaction_index, is_data_item, inserted_at, expires_at
--   FROM transactions;
--
-- On a large table, run it one partition at a time to bound memory, e.g.
-- `... FROM transactions WHERE intDiv(height, 100000) = 17`. Then set
-- CLICKHOUSE_GQL_ID_LOOKUP_ENABLED=true.

-- =============================================================================
-- Streaming pipeline: unstable head (mirrors the SQLite new_* tables)
-- =============================================================================
--
-- new_blocks / new_transactions hold the live unstable head of the chain
-- (~18 confirmations of recent data) streamed from the indexer's event bus.
-- The stable Parquet pipeline is unchanged — once a row stabilizes it lands
-- in `transactions` via parquet-export and the unstable copy ages out via
-- TTL. GraphQL merges the two at query time.
--
-- Deliberate departures from `transactions` (do not "fix"):
--   * No PARTITION BY — table covers a few thousand rows in a tight height
--     range; partition metadata costs more than partition pruning saves.
--   * No bloom skip indexes (id_bloom, target_bloom, owner_address_bloom,
--     tag_names_bloom, tag_values_bloom) — full scan is cheaper than the
--     index lookup at this size, and indexes only add merge cost.
--   * No owner_projection — same reasoning; not worth the merge cost.
--   * No deduplicate_merge_projection_mode = 'rebuild' — no projection.
--   * No offset/size pointer family — those are stable-pipeline artifacts;
--     unstable rows write `signature` and `owner` inline instead.
--   * No expires_at / operator TTL rules — uniform time-since-insert TTL
--     keyed off inserted_at; rows expire once stabilization handoff lands
--     them in `transactions`.
--
-- new_blocks is intentionally minimal (height + indep_hash). The only thing
-- read from it is the (height, indep_hash) pair for the orphan-filter join
-- against new_transactions; per-row block context on transactions queries
-- comes from the denormalized columns on new_transactions itself. A future
-- block-metadata table — if needed — should make its own partitioning and
-- indexing decisions in context, not inherit them from this minimal shape.
CREATE TABLE IF NOT EXISTS new_blocks (
  height UInt32 NOT NULL CODEC(Delta(4), LZ4),
  indep_hash BLOB,
  inserted_at DateTime CODEC(Delta(4), ZSTD(1)),
  PRIMARY KEY (height)
) Engine = ReplacingMergeTree(inserted_at)
ORDER BY (height)
TTL inserted_at + INTERVAL {{NEW_TX_TTL_MINUTES}} MINUTE;

-- Schema parity with `transactions` is the goal so the merge query treats
-- the two tables uniformly. Codecs match column-for-column; differences are
-- documented in the block comment above.
CREATE TABLE IF NOT EXISTS new_transactions (
  height UInt32 NOT NULL CODEC(Delta(4), LZ4),
  block_transaction_index UInt16 CODEC(Delta(2), LZ4),
  is_data_item Boolean,
  id BLOB NOT NULL,
  anchor BLOB NOT NULL CODEC(ZSTD(3)),
  owner_address BLOB,
  target BLOB,
  quantity Decimal(20,0) NOT NULL,
  reward Decimal(20,0) NOT NULL,
  data_size UInt64,
  content_type LowCardinality(String),
  format UInt8 NOT NULL,
  data_root BLOB,
  parent_id BLOB,
  block_indep_hash BLOB,
  block_timestamp UInt32 CODEC(Delta(4), ZSTD(1)),
  block_previous_block BLOB,
  indexed_at UInt64 CODEC(Delta(8), ZSTD(1)),
  inserted_at DateTime CODEC(Delta(4), ZSTD(1)),
  owner BLOB CODEC(ZSTD(3)),
  signature BLOB CODEC(ZSTD(3)),
  signature_type UInt8,
  root_transaction_id BLOB,
  root_parent_offset UInt64,
  tags Array(Tuple(BLOB, BLOB)),
  tags_count UInt32,
  -- MATERIALIZED twins of `tags` so SELECT projection lists are identical
  -- across `transactions` and `new_transactions` (the merge query treats
  -- both tables uniformly). No bloom skip indexes — full scan is cheap at
  -- this row count.
  tag_names Array(BLOB) MATERIALIZED arrayMap(x -> x.1, tags),
  tag_values Array(BLOB) MATERIALIZED arrayMap(x -> x.2, tags),
  PRIMARY KEY (height, block_transaction_index, is_data_item, id)
) Engine = ReplacingMergeTree(inserted_at)
ORDER BY (height, block_transaction_index, is_data_item, id)
TTL inserted_at + INTERVAL {{NEW_TX_TTL_MINUTES}} MINUTE;
