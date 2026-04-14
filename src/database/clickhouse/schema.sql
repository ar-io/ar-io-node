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
SETTINGS deduplicate_merge_projection_mode = 'rebuild';
