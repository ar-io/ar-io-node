ALTER TABLE stable_transactions ADD COLUMN offset INTEGER;

CREATE INDEX IF NOT EXISTS stable_transactions_offset_idx
  ON stable_transactions (offset)
  WHERE format = 2 AND data_size > 0;
