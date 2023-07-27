-- selectChainStats
WITH wallet_stats AS (
  SELECT
    COUNT(*) AS wallets_count
  FROM wallets
),
tag_name_stats AS (
  SELECT
    COUNT(*) AS tag_names_count
  FROM tag_names
),
tag_value_stats AS (
  SELECT
    COUNT(*) AS tag_values_count
  FROM tag_values
),
stable_block_stats AS (
  SELECT
    COUNT(*) AS stable_blocks_count,
    IFNULL(SUM(tx_count), 0) AS stable_block_txs_count,
    MIN(height) AS stable_blocks_min_height,
    MAX(height) AS stable_blocks_max_height
  FROM stable_blocks
),
new_block_stats AS (
  SELECT
    COUNT(*) AS new_blocks_count,
    MIN(height) AS new_blocks_min_height,
    MAX(height) AS new_blocks_max_height
  FROM new_blocks
),
stable_transaction_stats AS (
  SELECT
    COUNT(*) AS stable_txs_count,
    MIN(height) AS stable_txs_min_height,
    MAX(height) AS stable_txs_max_height
  FROM stable_transactions
),
new_transaction_stats AS (
  SELECT
    COUNT(*) AS new_txs_count,
    MIN(height) AS new_txs_min_height,
    MAX(height) AS new_txs_max_height
  FROM new_transactions
),
missing_transactions_stats AS (
  SELECT
    COUNT(*) AS missing_txs_count
  FROM missing_transactions
)
SELECT *
FROM
  wallet_stats,
  tag_name_stats,
  tag_value_stats,
  stable_block_stats,
  new_block_stats,
  stable_transaction_stats,
  new_transaction_stats,
  missing_transactions_stats
