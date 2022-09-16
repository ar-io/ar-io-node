-- selectWalletsCount
SELECT COUNT(*) AS count
FROM wallets

-- selectTagNamesCount
SELECT COUNT(*) AS count
FROM tag_names

-- selectTagValuesCount
SELECT COUNT(*) AS count
FROM tag_values

-- selectStableTransactionsCount
SELECT COUNT(*) AS count
FROM stable_transactions

-- selectStableBlockCount
SELECT COUNT(*) AS count
FROM stable_blocks

-- selectStableBlockTransactionCount
SELECT SUM(tx_count) AS count
FROM stable_blocks

-- selectMissingTransactionsCount
SELECT COUNT(*) AS count
FROM missing_transactions

-- selectNewTransactionsCount
SELECT COUNT(*) AS count
FROM new_transactions

-- selectNewBlocksCount
SELECT COUNT(*) AS count
FROM new_blocks
