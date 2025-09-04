#!/usr/bin/env bash

echo "Testing Individual Query Performance"
echo "====================================="
echo

# Test range
START_HEIGHT=1718100
END_HEIGHT=1718101

# Setup temp database
TEMP_DIR="data/test-query-timing"
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"
TEMP_DB="$TEMP_DIR/test.duckdb"
echo "Using temp database: $TEMP_DB"
echo

# Initialize DuckDB schema
duckdb "$TEMP_DB" < src/database/duckdb/schema.sql

echo "Testing SQLite attachment and queries..."
echo "-----------------------------------------"

# Test 1: Blocks query
echo "1. Blocks query (height $START_HEIGHT-$END_HEIGHT):"
START_TIME=$(date +%s%N)
duckdb "$TEMP_DB" <<SQL 2>/dev/null
ATTACH 'data/sqlite/core.db' AS core (TYPE SQLITE, READONLY TRUE);
INSERT INTO blocks
SELECT indep_hash, height, previous_block, nonce, hash, block_timestamp, tx_count, block_size
FROM core.stable_blocks
WHERE height BETWEEN $START_HEIGHT AND $END_HEIGHT;
SQL
END_TIME=$(date +%s%N)
DURATION=$(echo "scale=3; ($END_TIME - $START_TIME) / 1000000000" | bc)
COUNT=$(duckdb "$TEMP_DB" -csv -noheader -c "SELECT COUNT(*) FROM blocks;")
echo "   Duration: ${DURATION}s for $COUNT blocks"

# Test 2: L1 Transactions query
echo
echo "2. L1 Transactions query (height $START_HEIGHT-$END_HEIGHT):"
START_TIME=$(date +%s%N)
duckdb "$TEMP_DB" <<SQL 2>/dev/null
ATTACH 'data/sqlite/core.db' AS core (TYPE SQLITE, READONLY TRUE);
INSERT INTO transactions
SELECT
  id, indexed_at, block_transaction_index,
  0 AS is_data_item,
  target, quantity, reward,
  last_tx AS anchor,
  data_size, content_type, format,
  height, owner_address, data_root,
  NULL AS parent,
  "offset",
  data_size AS size,
  0 AS data_offset,
  0 AS owner_offset,  
  0 AS owner_size,
  NULL AS owner,
  0 AS signature_offset,
  0 AS signature_size,
  0 AS signature_type,
  id AS root_transaction_id,
  NULL AS root_parent_offset
FROM core.stable_transactions
WHERE height BETWEEN $START_HEIGHT AND $END_HEIGHT;
SQL
END_TIME=$(date +%s%N)
DURATION=$(echo "scale=3; ($END_TIME - $START_TIME) / 1000000000" | bc)
COUNT=$(duckdb "$TEMP_DB" -csv -noheader -c "SELECT COUNT(*) FROM transactions WHERE is_data_item = 0;")
echo "   Duration: ${DURATION}s for $COUNT L1 transactions"

# Test 3: L1 Tags query
echo
echo "3. L1 Tags query (height $START_HEIGHT-$END_HEIGHT):"
START_TIME=$(date +%s%N)
duckdb "$TEMP_DB" <<SQL 2>/dev/null
ATTACH 'data/sqlite/core.db' AS core (TYPE SQLITE, READONLY TRUE);
INSERT INTO tags
SELECT
  height, transaction_id AS id, transaction_tag_index AS tag_index,
  0 AS indexed_at,
  tag_name_hash AS tag_name, tag_value_hash AS tag_value,
  0 AS is_data_item
FROM core.stable_transaction_tags
WHERE height BETWEEN $START_HEIGHT AND $END_HEIGHT;
SQL
END_TIME=$(date +%s%N)
DURATION=$(echo "scale=3; ($END_TIME - $START_TIME) / 1000000000" | bc)
COUNT=$(duckdb "$TEMP_DB" -csv -noheader -c "SELECT COUNT(*) FROM tags WHERE is_data_item = 0;")
echo "   Duration: ${DURATION}s for $COUNT L1 tags"

# Test 4: L2 Data Items query
echo
echo "4. L2 Data Items query (height $START_HEIGHT-$END_HEIGHT):"
START_TIME=$(date +%s%N)
duckdb "$TEMP_DB" <<SQL 2>/dev/null
ATTACH 'data/sqlite/bundles.db' AS bundles (TYPE SQLITE, READONLY TRUE);
INSERT INTO transactions
SELECT
  id, indexed_at, block_transaction_index,
  1 AS is_data_item,
  target, NULL AS quantity, NULL AS reward, anchor, data_size, content_type,
  NULL AS format,
  height, owner_address,
  NULL AS data_root,
  parent_id AS parent,
  "offset", size, data_offset,
  owner_offset, owner_size,
  NULL AS owner,
  signature_offset, signature_size, signature_type,
  root_transaction_id,
  0 AS root_parent_offset
FROM bundles.stable_data_items
WHERE height BETWEEN $START_HEIGHT AND $END_HEIGHT;
SQL
END_TIME=$(date +%s%N)
DURATION=$(echo "scale=3; ($END_TIME - $START_TIME) / 1000000000" | bc)
COUNT=$(duckdb "$TEMP_DB" -csv -noheader -c "SELECT COUNT(*) FROM transactions WHERE is_data_item = 1;")
echo "   Duration: ${DURATION}s for $COUNT L2 data items"

# Test 5: L2 Tags query
echo
echo "5. L2 Tags query (height $START_HEIGHT-$END_HEIGHT):"
START_TIME=$(date +%s%N)
duckdb "$TEMP_DB" <<SQL 2>/dev/null
ATTACH 'data/sqlite/bundles.db' AS bundles (TYPE SQLITE, READONLY TRUE);
INSERT INTO tags
SELECT
  height, data_item_id AS id, data_item_tag_index AS tag_index,
  0 AS indexed_at,
  tag_name_hash AS tag_name, tag_value_hash AS tag_value,
  1 AS is_data_item
FROM bundles.stable_data_item_tags
WHERE height BETWEEN $START_HEIGHT AND $END_HEIGHT;
SQL
END_TIME=$(date +%s%N)
DURATION=$(echo "scale=3; ($END_TIME - $START_TIME) / 1000000000" | bc)
COUNT=$(duckdb "$TEMP_DB" -csv -noheader -c "SELECT COUNT(*) FROM tags WHERE is_data_item = 1;")
echo "   Duration: ${DURATION}s for $COUNT L2 tags"

echo
echo "Performance Summary:"
echo "-------------------"
duckdb "$TEMP_DB" -csv -noheader <<SQL
SELECT 
  'Total blocks:' as metric, COUNT(*) as count FROM blocks
UNION ALL
SELECT 'Total L1 tx:', COUNT(*) FROM transactions WHERE is_data_item = 0
UNION ALL  
SELECT 'Total L2 tx:', COUNT(*) FROM transactions WHERE is_data_item = 1
UNION ALL
SELECT 'Total L1 tags:', COUNT(*) FROM tags WHERE is_data_item = 0
UNION ALL
SELECT 'Total L2 tags:', COUNT(*) FROM tags WHERE is_data_item = 1;
SQL

# Cleanup
rm -rf "$TEMP_DIR"