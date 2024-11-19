CREATE TABLE IF NOT EXISTS staging_blocks (
  indep_hash BLOB,
  height UInt64 NOT NULL,
  previous_block BLOB,
  nonce BLOB NOT NULL,
  hash BLOB NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_count UInt32 NOT NULL,
  block_size UInt64,
  PRIMARY KEY (height)
) Engine = MergeTree()
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
  signature_type UInt64,
  PRIMARY KEY (height, block_transaction_index, is_data_item, id)
) Engine = MergeTree()
ORDER BY (height, block_transaction_index, is_data_item, id);

CREATE TABLE IF NOT EXISTS staging_tags (
  height UInt32 NOT NULL,
  id BLOB NOT NULL,
  tag_index UInt16 NOT NULL,
  indexed_at UInt64,
  tag_name BLOB NOT NULL,
  tag_value BLOB NOT NULL,
  is_data_item BOOLEAN NOT NULL,
  PRIMARY KEY (height, id)
) Engine = MergeTree()
ORDER BY (height, id);

CREATE TABLE IF NOT EXISTS transactions (
  height UInt32 NOT NULL,
  block_transaction_index UInt16,
  is_data_item Boolean,
  id BLOB NOT NULL,
  anchor BLOB NOT NULL,
  owner_address BLOB,
  target BLOB,
  quantity Decimal(20,0) NOT NULL,
  reward Decimal(20,0) NOT NULL,
  data_size UInt64,
  content_type String,
  format UInt8 NOT NULL,
  data_root BLOB,
  parent_id BLOB,
  block_indep_hash BLOB,
  block_timestamp UInt32,
  block_previous_block BLOB,
  indexed_at UInt64,
  updated_at UInt64,
  tags Array(Tuple(BLOB, BLOB)),
  PRIMARY KEY (height, block_transaction_index, is_data_item, id)
) Engine = MergeTree()
ORDER BY (height, block_transaction_index, is_data_item, id);

CREATE TABLE IF NOT EXISTS owner_transactions (
  height UInt32 NOT NULL,
  block_transaction_index UInt16,
  is_data_item Boolean,
  id BLOB NOT NULL,
  anchor BLOB NOT NULL,
  owner_address BLOB,
  target BLOB,
  quantity Decimal(20,0) NOT NULL,
  reward Decimal(20,0) NOT NULL,
  data_size UInt64,
  content_type String,
  format UInt8 NOT NULL,
  data_root BLOB,
  parent_id BLOB,
  block_indep_hash BLOB,
  block_timestamp UInt32,
  block_previous_block BLOB,
  indexed_at UInt64,
  updated_at UInt64,
  tags Array(Tuple(BLOB, BLOB)),
  PRIMARY KEY (owner_address, height, block_transaction_index, is_data_item, id)
) Engine = MergeTree()
ORDER BY (owner_address, height, block_transaction_index, is_data_item, id);

CREATE TABLE IF NOT EXISTS target_transactions (
  height UInt32 NOT NULL,
  block_transaction_index UInt16,
  is_data_item Boolean,
  id BLOB NOT NULL,
  anchor BLOB NOT NULL,
  owner_address BLOB,
  target BLOB,
  quantity Decimal(20,0) NOT NULL,
  reward Decimal(20,0) NOT NULL,
  data_size UInt64,
  content_type String,
  format UInt8 NOT NULL,
  data_root BLOB,
  parent_id BLOB,
  block_indep_hash BLOB,
  block_timestamp UInt32,
  block_previous_block BLOB,
  indexed_at UInt64,
  updated_at UInt64,
  tags Array(Tuple(BLOB, BLOB)),
  PRIMARY KEY (target, height, block_transaction_index, is_data_item, id)
) Engine = MergeTree()
ORDER BY (target, height, block_transaction_index, is_data_item, id);
