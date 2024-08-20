CREATE TABLE stable_transactions_new (
  -- Identity
  id BLOB PRIMARY KEY,
  height INTEGER NOT NULL,
  block_transaction_index INTEGER NOT NULL,
  signature BLOB NOT NULL, -- Changed back to NOT NULL
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
  offset INTEGER,
  content_encoding TEXT
);

INSERT INTO stable_transactions_new SELECT * FROM stable_transactions;
DROP TABLE stable_transactions;
ALTER TABLE stable_transactions_new RENAME TO stable_transactions;

CREATE INDEX stable_transactions_id_height_block_transaction_index_idx ON stable_transactions (height, block_transaction_index);
CREATE INDEX stable_transactions_target_height_block_transaction_index_idx ON stable_transactions (target, height, block_transaction_index);
CREATE INDEX stable_transactions_owner_address_height_block_transaction_index_idx ON stable_transactions (owner_address, height, block_transaction_index);
CREATE INDEX stable_transactions_offset_idx
  ON stable_transactions (offset)
  WHERE format = 2 AND data_size > 0;

CREATE TABLE new_transactions (
  -- Identity
  id BLOB PRIMARY KEY,
  signature BLOB NOT NULL, -- Changed back to NOT NULL
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
  indexed_at INTEGER NOT NULL,
  height INTEGER,
  content_encoding TEXT
);

INSERT INTO new_transactions_new SELECT * FROM new_transactions;
DROP TABLE new_transactions;
ALTER TABLE new_transactions_new RENAME TO new_transactions;

CREATE INDEX new_transactions_target_id_idx ON new_transactions (target, id);
CREATE INDEX new_transactions_owner_address_id_idx ON new_transactions (owner_address, id);
CREATE INDEX new_transactions_height_indexed_at_idx ON new_transactions (height, indexed_at);
