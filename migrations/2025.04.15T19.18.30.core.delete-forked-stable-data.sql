-- up migration
DELETE FROM stable_transaction_tags
WHERE transaction_id IN (
  SELECT id
  FROM stable_transactions
  WHERE height > (
    SELECT COALESCE(MAX(height) - 30, 9999999)
    FROM stable_blocks
  )
);

DELETE FROM stable_transactions
WHERE height > (
  SELECT COALESCE(MAX(height) - 30, 9999999)
  FROM stable_blocks
);

DELETE FROM stable_block_transactions
WHERE block_indep_hash IN (
  SELECT indep_hash
  FROM stable_blocks
  WHERE height > (
    SELECT COALESCE(MAX(height) - 30, 9999999)
    FROM stable_blocks
  )
);

DELETE FROM stable_blocks
WHERE height > (
  SELECT COALESCE(MAX(height) - 30, 9999999)
  FROM stable_blocks
);
