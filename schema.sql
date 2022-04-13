--CREATE TABLE stable_blocks (
--  -- Identity
--  height INTEGER PRIMARY KEY,
--  indep_hash BLOB UNIQUE,
--  previous_block BLOB,
--  nonce BLOB NOT NULL,
--  hash BLOB NOT NULL,
--  block_timestamp INTEGER NOT NULL,
--
--  -- Difficulty
--  diff TEXT NOT NULL,
--  cumulative_diff TEXT,
--  last_retarget TEXT NOT NULL,
--
--  -- Rewards
--  reward_addr BLOB,
--  reward_pool TEXT NOT NULL,
--
--  -- Sizes
--  block_size INTEGER NOT NULL,
--  weave_size INTEGER NOT NULL,
--
--  -- Pricing
--  usd_to_ar_rate_dividend INTEGER,
--  usd_to_ar_rate_divisor INTEGER,
--  scheduled_usd_to_ar_rate_dividend INTEGER,
--  scheduled_usd_to_ar_rate_divisor INTEGER,
--
--  -- Packing
--  packing_2_5_threshold INTEGER,
--  strict_data_split_threshold INTEGER,
--
--  -- Hash list merkel
--  hash_list_merkle BLOB,
--
--  -- Wallets
--  wallet_list BLOB,
--
--  -- Transactions
--  tx_root BLOB
--);

CREATE TABLE stable_transactions (
  -- Identity
  id BLOB PRIMARY KEY,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL
  --signature BLOB NOT NULL,
  --format INTEGER NOT NULL,
  --last_tx BLOB NOT NULL,

  -- Ownership
  --owner_address BLOB NOT NULL,
  --target BLOB,

  -- Tokens
  --quantity TEXT NOT NULL,
  --reward TEXT NOT NULL,

  -- Data
  --data_size INTEGER,
  --data_root BLOB
);

CREATE INDEX stable_transactions_id_height_idx ON stable_transactions (height, block_transaction_index);

CREATE TABLE tags (
  hash BLOB PRIMARY KEY,
  name BLOB NOT NULL,
  value BLOB NOT NULL
);

CREATE TABLE stable_transaction_tags (
  tag_hash BLOB NOT NULL,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  --transaction_tag_index INTEGER NOT NULL,
  PRIMARY KEY (tag_hash, height, block_transaction_index)
);
