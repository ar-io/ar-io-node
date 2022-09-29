CREATE TABLE IF NOT EXISTS new_block_heights (
  height INTEGER PRIMARY KEY,
  block_indep_hash BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS new_block_heights_block_indep_hash_idx ON new_block_heights (height, block_indep_hash);
