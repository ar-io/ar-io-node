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
  INDEX tag_names_bloom tag_names TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX tag_values_bloom tag_values TYPE bloom_filter(0.01) GRANULARITY 4,
  PROJECTION owner_projection (
    SELECT *
    ORDER BY (owner_address, height, block_transaction_index, is_data_item, id)
  ),
  PRIMARY KEY (height, block_transaction_index, is_data_item, id)
) Engine = ReplacingMergeTree(inserted_at)
PARTITION BY intDiv(height, 100000)
ORDER BY (height, block_transaction_index, is_data_item, id)
TTL expires_at DELETE WHERE expires_at IS NOT NULL
SETTINGS deduplicate_merge_projection_mode = 'rebuild';

-- Idempotent upgrade path for nodes that already have a transactions table
-- from before tag-based TTL rules were introduced. Safe to re-run; a no-op
-- once applied.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS expires_at Nullable(DateTime);
ALTER TABLE transactions MODIFY TTL expires_at DELETE WHERE expires_at IS NOT NULL;

-- Tag-based TTL rules. Operators populate the `_src` / prefix tables via
-- scripts/clickhouse-load-ttl-rules.py (run by clickhouse-auto-import once per
-- import cycle). The dictionaries layered over the exact-match source tables
-- refresh on their LIFETIME without external orchestration.
--
-- Schema contract:
--   - tag_name is stored lower-cased (normalization happens in the loader);
--     the migrate query lower-casts the row's tag_name BLOB to String before
--     dictionary / prefix lookup.
--   - tag_value is stored trimmed but case-preserving.
--   - owner_address is stored as the raw bytes decoded from the base64url
--     form used in the rules file; matches the transactions.owner_address
--     BLOB byte-for-byte once CAST(... AS String).
--   - Prefix rules are scanned by startsWith() in correlated subqueries;
--     exact rules go through dictGetOrNull() for O(1) lookup.
CREATE TABLE IF NOT EXISTS ttl_tag_rules_src (
  tag_name String,
  tag_value String,
  ttl_seconds UInt32
) Engine = ReplacingMergeTree()
ORDER BY (tag_name, tag_value);

CREATE TABLE IF NOT EXISTS ttl_tag_prefix_rules (
  tag_name String,
  tag_value String,
  ttl_seconds UInt32
) Engine = ReplacingMergeTree()
ORDER BY (tag_name, tag_value);

CREATE TABLE IF NOT EXISTS ttl_owner_rules_src (
  owner_address String,
  ttl_seconds UInt32
) Engine = ReplacingMergeTree()
ORDER BY owner_address;

CREATE TABLE IF NOT EXISTS ttl_owner_prefix_rules (
  owner_address String,
  ttl_seconds UInt32
) Engine = ReplacingMergeTree()
ORDER BY owner_address;

CREATE DICTIONARY IF NOT EXISTS ttl_tag_rules (
  tag_name String,
  tag_value String,
  ttl_seconds UInt32
)
PRIMARY KEY tag_name, tag_value
SOURCE(CLICKHOUSE(TABLE 'ttl_tag_rules_src'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 60 MAX 300);

CREATE DICTIONARY IF NOT EXISTS ttl_owner_rules (
  owner_address String,
  ttl_seconds UInt32
)
PRIMARY KEY owner_address
SOURCE(CLICKHOUSE(TABLE 'ttl_owner_rules_src'))
LAYOUT(COMPLEX_KEY_HASHED())
LIFETIME(MIN 60 MAX 300);
