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

-- TODO add content_type
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
  data_root BLOB
);

CREATE INDEX stable_transactions_id_height_block_transaction_index_idx ON stable_transactions (height, block_transaction_index);
CREATE INDEX stable_transactions_target_height_block_transaction_index_idx ON stable_transactions (target, height, block_transaction_index);
CREATE INDEX stable_transactions_owner_address_height_block_transaction_index_idx ON stable_transactions (owner_address, height, block_transaction_index);

-- Use combo hash, name, value as PK so we can detect duplicate hashes
CREATE TABLE tags (
  hash BLOB PRIMARY KEY,
  name BLOB NOT NULL,
  value BLOB NOT NULL
);

CREATE TABLE stable_transaction_tags (
  tag_hash BLOB NOT NULL,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  transaction_tag_index INTEGER NOT NULL,
  PRIMARY KEY (tag_hash, height, block_transaction_index, transaction_tag_index)
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

-- TODO add block indexes

CREATE TABLE new_block_heights (
  height INTEGER PRIMARY KEY,
  block_indep_hash BLOB NOT NULL
);

CREATE INDEX new_block_heights_block_indep_hash_idx ON new_block_heights (height, block_indep_hash);

-- TODO add tag(s)_count
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

  -- Metadata
  created_at INTEGER NOT NULL
);

CREATE INDEX stable_transactions_target_id_idx ON new_transactions (target, id);
CREATE INDEX stable_transactions_owner_address_id_idx ON new_transactions (owner_address, id);

CREATE TABLE new_block_transactions (
  block_indep_hash BYTEA,
  transaction_id BYTEA NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  PRIMARY KEY(block_indep_hash, transaction_id, block_transaction_index)
);

CREATE TABLE new_transaction_tags (
  tag_hash BLOB NOT NULL,
  transaction_id BLOB NOT NULL,
  transaction_tag_index INTEGER NOT NULL,
  PRIMARY KEY (tag_hash, transaction_id, transaction_tag_index)
);
