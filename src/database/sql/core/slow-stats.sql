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
SELECT IFNULL(SUM(tx_count), 0) AS count
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
