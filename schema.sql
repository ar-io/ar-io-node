CREATE TABLE wallets (
  address BLOB PRIMARY KEY,
  public_modulus BLOB
);

CREATE TABLE stable_blocks (
  -- Identity
  height INTEGER PRIMARY KEY,
  indep_hash BLOB UNIQUE,
  previous_block BLOB,
  nonce BLOB NOT NULL,
  hash BLOB NOT NULL,
  block_timestamp INTEGER NOT NULL,

  -- Difficulty
  diff TEXT NOT NULL,
  cumulative_diff TEXT,
  last_retarget TEXT NOT NULL,

  -- Rewards
  reward_addr BLOB,
  reward_pool TEXT NOT NULL,

  -- Sizes
  block_size INTEGER NOT NULL,
  weave_size INTEGER NOT NULL,

  -- Pricing
  usd_to_ar_rate_dividend INTEGER,
  usd_to_ar_rate_divisor INTEGER,
  scheduled_usd_to_ar_rate_dividend INTEGER,
  scheduled_usd_to_ar_rate_divisor INTEGER,

  -- Hash list merkel
  hash_list_merkle BLOB,

  -- Wallets
  wallet_list BLOB,

  -- Transactions
  tx_root BLOB,

  -- Metadata
  tx_count INTEGER NOT NULL,
  missing_tx_count INTEGER NOT NULL
);

CREATE INDEX stable_blocks_missing_tx_count_idx ON stable_blocks (missing_tx_count);

CREATE TABLE stable_transactions (
  -- Identity
  id BLOB PRIMARY KEY,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  signature BLOB NOT NULL,
  format INTEGER NOT NULL,
  last_tx BLOB NOT NULL,

  -- Ownership
  owner_address BLOB NOT NULL,
  target BLOB,

  -- Tokens
  quantity TEXT NOT NULL,
  reward TEXT NOT NULL,

  -- Data
  data_size INTEGER,
  data_root BLOB,
  content_type TEXT,

  -- Metadata
  tag_count INTEGER NOT NULL
);

CREATE INDEX stable_transactions_id_height_block_transaction_index_idx ON stable_transactions (height, block_transaction_index);
CREATE INDEX stable_transactions_target_height_block_transaction_index_idx ON stable_transactions (target, height, block_transaction_index);
CREATE INDEX stable_transactions_owner_address_height_block_transaction_index_idx ON stable_transactions (owner_address, height, block_transaction_index);

CREATE TABLE missing_transactions (
  block_indep_hash BLOB NOT NULL,
  transaction_id BLOB NOT NULL,
  height INTEGER NOT NULL,
  PRIMARY KEY (block_indep_hash, transaction_id)
);

CREATE INDEX missing_transactions_height_idx ON missing_transactions (height);

CREATE TABLE tag_names (
  hash BLOB PRIMARY KEY,
  name BLOB NOT NULL
);

CREATE TABLE tag_values (
  hash BLOB PRIMARY KEY,
  value BLOB NOT NULL
);

CREATE TABLE stable_transaction_tags (
  tag_name_hash BLOB NOT NULL,
  tag_value_hash BLOB NOT NULL,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  transaction_tag_index INTEGER NOT NULL,
  transaction_id BLOB NOT NULL,
  PRIMARY KEY (tag_name_hash, tag_value_hash, height, block_transaction_index, transaction_tag_index)
);

CREATE TABLE new_blocks (
  -- Identity
  indep_hash BLOB PRIMARY KEY,
  height INTEGER NOT NULL,
  previous_block BLOB,
  nonce BLOB NOT NULL,
  hash BLOB NOT NULL,
  block_timestamp INTEGER NOT NULL,

  -- Difficulty
  diff TEXT NOT NULL,
  cumulative_diff TEXT,
  last_retarget INTEGER NOT NULL,

  -- Rewards
  reward_addr BLOB,
  reward_pool TEXT NOT NULL,

  -- Sizes
  block_size INTEGER NOT NULL,
  weave_size INTEGER NOT NULL,

  -- Pricing
  usd_to_ar_rate_dividend INTEGER,
  usd_to_ar_rate_divisor INTEGER,
  scheduled_usd_to_ar_rate_dividend INTEGER,
  scheduled_usd_to_ar_rate_divisor INTEGER,

  -- Hash list merkel
  hash_list_merkle BLOB,

  -- Wallets
  wallet_list BLOB,

  -- Transactions
  tx_root BLOB,

  -- Metadata
  tx_count INTEGER NOT NULL,
  missing_tx_count INTEGER NOT NULL
);

CREATE INDEX new_blocks_height_idx ON new_blocks (height);

CREATE TABLE new_block_heights (
  height INTEGER PRIMARY KEY,
  block_indep_hash BLOB NOT NULL
);

CREATE INDEX new_block_heights_block_indep_hash_idx ON new_block_heights (height, block_indep_hash);

CREATE TABLE new_transactions (
  -- Identity
  id BLOB PRIMARY KEY,
  signature BLOB NOT NULL,
  format INTEGER NOT NULL,
  last_tx BLOB NOT NULL,

  -- Ownership
  owner_address BLOB NOT NULL,
  target BLOB,

  -- Tokens
  quantity TEXT NOT NULL,
  reward TEXT NOT NULL,

  -- Data
  data_size INTEGER,
  data_root BLOB,
  content_type TEXT,

  -- Metadata
  tag_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX new_transactions_target_id_idx ON new_transactions (target, id);
CREATE INDEX new_transactions_owner_address_id_idx ON new_transactions (owner_address, id);
CREATE INDEX new_transactions_created_at_idx ON new_transactions (created_at);

CREATE TABLE new_block_transactions (
  block_indep_hash BYTEA,
  transaction_id BYTEA NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  PRIMARY KEY(block_indep_hash, transaction_id, block_transaction_index)
);

CREATE TABLE new_transaction_tags (
  tag_name_hash BLOB NOT NULL,
  tag_value_hash BLOB NOT NULL,
  transaction_id BLOB NOT NULL,
  transaction_tag_index INTEGER NOT NULL,
  PRIMARY KEY (tag_name_hash, tag_value_hash, transaction_id, transaction_tag_index)
);

--CREATE TABLE data_item_owners (
--  address BLOB PRIMARY KEY,
--  owner BLOB
--);
--
--CREATE TABLE stable_data_items (
--  id BLOB NOT NULL,
--  parent_transaction_id BLOB NOT NULL,
--  height INTEGER NOT NULL,
--  block_transaction_index INTEGER NOT NULL,
--  bundle_data_item_index INTEGER NOT NULL,
--  signature BLOB NOT NULL,
--  owner_address BLOB NOT NULL,
--  target BLOB NOT NULL,
--  anchor BLOB NOT NULL,
--  data_size INTEGER NOT NULL,
--  PRIMARY KEY (id, parent_transaction_id)
--);
--
--CREATE INDEX stable_data_items_lookup_idx ON stable_data_items (id, height, block_transaction_index, bundle_data_item_index);
--CREATE INDEX stable_data_items_sort_idx ON stable_data_items (height, block_transaction_index, bundle_data_item_index);
--
--CREATE TABLE stable_data_item_tags (
--  tag_name_hash BLOB NOT NULL,
--  tag_value_hash BLOB NOT NULL,
--  height INTEGER NOT NULL,
--  block_transaction_index INTEGER NOT NULL,
--  bundle_data_item_index INTEGER NOT NULL,
--  data_item_tag_index INTEGER NOT NULL,
--  data_item_id BLOB NOT NULL,
--  PRIMARY KEY (tag_name_hash, tag_value_hash, height, block_transaction_index, bundle_data_item_index, data_item_tag_index)
--);
--
--CREATE TABLE new_data_items (
--  parent_transaction_id BLOB NOT NULL,
--  id BLOB NOT NULL,
--  bundle_data_item_index INTEGER NOT NULL,
--  signature BLOB NOT NULL,
--  owner_address BLOB NOT NULL,
--  target BLOB NOT NULL,
--  anchor BLOB NOT NULL,
--  data_size INTEGER NOT NULL,
--  PRIMARY KEY (parent_transaction_id, id)
--);
--
--CREATE TABLE new_data_item_tags (
--  tag_name_hash BLOB NOT NULL,
--  tag_value_hash BLOB NOT NULL,
--  parent_transaction_id BLOB NOT NULL,
--  data_item_id BLOB NOT NULL,
--  data_item_tag_index INTEGER NOT NULL,
--  PRIMARY KEY (tag_name_hash, tag_value_hash, parent_transaction_id, data_item_id, data_item_tag_index)
--);
--
--CREATE TABLE chunks (
--  data_root BLOB NOT NULL,
--  data_size INTEGER NOT NULL,
--  offset INTEGER NOT NULL,
--  data_path BLOB NOT NULL,
--  created_at INTEGER NOT NULL,
--  last_exported_at INTEGER,
--  PRIMARY KEY (data_root, data_size, offset)
--);
--
--CREATE INDEX chunks_last_exported_at_idx ON chunks (last_exported_at);
