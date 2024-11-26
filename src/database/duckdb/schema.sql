CREATE TABLE IF NOT EXISTS tags (
  height UBIGINT NOT NULL,
  id BLOB NOT NULL,
  tag_index USMALLINT NOT NULL,
  indexed_at UBIGINT,
  tag_name BLOB NOT NULL,
  tag_value BLOB NOT NULL,
  is_data_item BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id BLOB NOT NULL,
  indexed_at UBIGINT,
  block_transaction_index USMALLINT,
  is_data_item BOOLEAN,
  target BLOB,
  quantity DECIMAL(20,0),
  reward DECIMAL(20,0),
  anchor BLOB NOT NULL,
  data_size UBIGINT,
  content_type TEXT,
  format UTINYINT,
  height UBIGINT NOT NULL,
  owner_address BLOB,
  data_root BLOB,
  parent BLOB,
  "offset" UBIGINT,
  size UINTEGER,
  data_offset UINTEGER,
  owner_offset UINTEGER,
  owner_size UINTEGER,
  owner BLOB,
  signature_offset UINTEGER,
  signature_size UINTEGER,
  signature_type UINTEGER,
  root_transaction_id BLOB,
  root_parent_offset UINTEGER
);

CREATE TABLE IF NOT EXISTS blocks (
  indep_hash BLOB,
  height UBIGINT NOT NULL,
  previous_block BLOB,
  nonce BLOB NOT NULL,
  hash BLOB NOT NULL,
  block_timestamp INTEGER NOT NULL,
  tx_count INTEGER NOT NULL,
  block_size UINTEGER
);
