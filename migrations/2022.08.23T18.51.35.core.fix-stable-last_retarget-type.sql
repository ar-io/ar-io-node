CREATE TABLE tmp_stable_blocks (
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

INSERT INTO tmp_stable_blocks SELECT * FROM stable_blocks;

DROP INDEX stable_blocks_missing_tx_count_idx;

DROP TABLE stable_blocks;

ALTER TABLE tmp_stable_blocks RENAME TO stable_blocks;

-- Just in case... (SQLite types can be deceptive)
UPDATE stable_blocks SET last_retarget = CAST(last_retarget AS INTEGER);
UPDATE new_blocks SET last_retarget = CAST(last_retarget AS INTEGER);

CREATE INDEX IF NOT EXISTS stable_blocks_missing_tx_count_idx ON stable_blocks (missing_tx_count);
