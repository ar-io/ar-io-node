#!/usr/bin/env bash

echo "Data Integrity Test for Parquet Exports"
echo "========================================"
echo

# Test parameters
EXPORT_DIR="${1:-data/test-quick}"

if [[ ! -d "$EXPORT_DIR" ]]; then
  echo "Error: Export directory $EXPORT_DIR not found"
  echo "Usage: $0 [export_directory]"
  exit 1
fi

echo "Checking export: $EXPORT_DIR"
echo

# Function to check binary field format
check_binary_field() {
  local file=$1
  local field=$2
  local table=$3
  
  # Binary fields in DuckDB Parquet are stored as BLOB type
  # Check for null or empty values
  local invalid_count=$(duckdb -csv -noheader -c "
    SELECT COUNT(*) FROM read_parquet('$file', hive_partitioning=false)
    WHERE $field IS NULL OR LENGTH($field) = 0;
  " 2>/dev/null || echo "error")
  
  if [[ "$invalid_count" == "error" ]]; then
    echo "  ⚠ $table.$field: Could not check"
  elif [[ "$invalid_count" == "0" ]] || [[ -z "$invalid_count" ]]; then
    echo "  ✓ $table.$field: All binary values present"
  else
    echo "  ✗ $table.$field: Found $invalid_count null/empty values"
  fi
}

# 1. Check height continuity in blocks
echo "1. Height Continuity Check:"
echo "----------------------------"
GAPS=$(duckdb -csv -noheader -c "
  WITH block_heights AS (
    SELECT DISTINCT height 
    FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false)
    ORDER BY height
  ),
  expected AS (
    SELECT MIN(height) + generate_series AS expected_height
    FROM block_heights, 
         generate_series(0, (SELECT MAX(height) - MIN(height) FROM block_heights))
  )
  SELECT COUNT(*) as missing_blocks
  FROM expected e
  LEFT JOIN block_heights b ON e.expected_height = b.height
  WHERE b.height IS NULL;
" 2>/dev/null || echo "error")

if [[ "$GAPS" == "0" ]] || [[ -z "$GAPS" ]]; then
  echo "  ✓ No gaps in block heights"
else
  echo "  ✗ Found $GAPS missing blocks"
fi

# 2. Check referential integrity
echo
echo "2. Referential Integrity:"
echo "-------------------------"

# Check if all transactions have valid block heights
TX_WITHOUT_BLOCKS=$(duckdb -csv -noheader -c "
  WITH blocks AS (
    SELECT DISTINCT height FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false)
  ),
  txs AS (
    SELECT DISTINCT height FROM read_parquet('$EXPORT_DIR/transactions/data/*/*.parquet', hive_partitioning=false)
  )
  SELECT COUNT(*) FROM txs
  WHERE height NOT IN (SELECT height FROM blocks);
" 2>/dev/null || echo "0")

if [[ "$TX_WITHOUT_BLOCKS" == "0" ]]; then
  echo "  ✓ All transactions reference valid blocks"
else
  echo "  ✗ Found $TX_WITHOUT_BLOCKS transactions with invalid block heights"
fi

# Check if all tags have valid transaction IDs (sample check)
echo "  ⚠ Tag-transaction reference check (sampling first partition)..."
FIRST_PARTITION=$(find "$EXPORT_DIR/tags/data" -mindepth 1 -maxdepth 1 -type d | head -1)
if [[ -n "$FIRST_PARTITION" ]]; then
  ORPHAN_TAGS=$(duckdb -csv -noheader -c "
    WITH tx_ids AS (
      SELECT DISTINCT id FROM read_parquet('$EXPORT_DIR/transactions/data/*/*.parquet', hive_partitioning=false)
    ),
    tag_ids AS (
      SELECT DISTINCT id FROM read_parquet('$FIRST_PARTITION/*.parquet', hive_partitioning=false)
    )
    SELECT COUNT(*) FROM tag_ids
    WHERE id NOT IN (SELECT id FROM tx_ids);
  " 2>/dev/null || echo "0")
  
  if [[ "$ORPHAN_TAGS" == "0" ]]; then
    echo "    ✓ Sample check: All tags reference valid transactions"
  else
    echo "    ✗ Sample check: Found $ORPHAN_TAGS orphaned tags"
  fi
fi

# 3. Check data types and nulls
echo
echo "3. Data Type Validation:"
echo "------------------------"

# Check blocks required fields
BLOCKS_WITH_NULLS=$(duckdb -csv -noheader -c "
  SELECT COUNT(*) FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false)
  WHERE height IS NULL OR hash IS NULL OR nonce IS NULL;
" 2>/dev/null || echo "0")

if [[ "$BLOCKS_WITH_NULLS" == "0" ]]; then
  echo "  ✓ Blocks: No null values in required fields"
else
  echo "  ✗ Blocks: Found $BLOCKS_WITH_NULLS rows with null required fields"
fi

# Check binary field formats
echo
echo "4. Binary Field Validation (sample):"
echo "------------------------------------"
SAMPLE_BLOCK_FILE=$(find "$EXPORT_DIR/blocks/data" -name "*.parquet" | head -1)
if [[ -n "$SAMPLE_BLOCK_FILE" ]]; then
  check_binary_field "$SAMPLE_BLOCK_FILE" "hash" "blocks"
  check_binary_field "$SAMPLE_BLOCK_FILE" "indep_hash" "blocks"
fi

# 5. Check partition boundaries
echo
echo "5. Partition Boundary Check:"
echo "----------------------------"
for table in blocks transactions tags; do
  if [[ -d "$EXPORT_DIR/$table/data" ]]; then
    echo "  Checking $table partitions..."
    
    for partition_dir in "$EXPORT_DIR/$table/data"/height=*; do
      if [[ -d "$partition_dir" ]]; then
        partition_name=$(basename "$partition_dir")
        # Extract range from height=START-END format
        range=${partition_name#height=}
        start_height=${range%-*}
        end_height=${range#*-}
        
        # Check if data is within bounds
        OUT_OF_BOUNDS=$(duckdb -csv -noheader -c "
          SELECT COUNT(*) FROM read_parquet('$partition_dir/*.parquet', hive_partitioning=false)
          WHERE height < $start_height OR height > $end_height;
        " 2>/dev/null || echo "error")
        
        if [[ "$OUT_OF_BOUNDS" == "error" ]]; then
          echo "    ⚠ $partition_name: Could not check bounds"
        elif [[ "$OUT_OF_BOUNDS" == "0" ]]; then
          echo "    ✓ $partition_name: All data within bounds"
        else
          echo "    ✗ $partition_name: Found $OUT_OF_BOUNDS rows outside partition bounds"
        fi
      fi
    done
  fi
done

# 6. Check for duplicates and uniqueness
echo
echo "6. Duplicate Detection & Uniqueness:"
echo "------------------------------------"

# Check for duplicate blocks at same height
DUPLICATE_BLOCKS=$(duckdb -csv -noheader -c "
  SELECT COUNT(*) - COUNT(DISTINCT height)
  FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false);
" 2>/dev/null || echo "error")

if [[ "$DUPLICATE_BLOCKS" == "error" ]]; then
  echo "  ⚠ Could not check for duplicate blocks"
elif [[ "$DUPLICATE_BLOCKS" == "0" ]]; then
  echo "  ✓ No duplicate blocks at same height"
else
  echo "  ✗ Found $DUPLICATE_BLOCKS duplicate blocks at same height"
fi

# Check uniqueness of block hashes
echo "  Checking block hash uniqueness..."
BLOCK_HASH_DUPS=$(duckdb -csv -noheader -c "
  WITH hash_counts AS (
    SELECT hash, COUNT(*) as cnt
    FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false)
    WHERE hash IS NOT NULL
    GROUP BY hash
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*) FROM hash_counts;
" 2>/dev/null || echo "error")

if [[ "$BLOCK_HASH_DUPS" == "error" ]]; then
  echo "  ⚠ Could not check block hash uniqueness"
elif [[ "$BLOCK_HASH_DUPS" == "0" ]]; then
  echo "  ✓ All block hashes are unique"
else
  echo "  ✗ Found $BLOCK_HASH_DUPS duplicate block hashes"
fi

# Check uniqueness of indep_hash
INDEP_HASH_DUPS=$(duckdb -csv -noheader -c "
  WITH hash_counts AS (
    SELECT indep_hash, COUNT(*) as cnt
    FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false)
    WHERE indep_hash IS NOT NULL
    GROUP BY indep_hash
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*) FROM hash_counts;
" 2>/dev/null || echo "error")

if [[ "$INDEP_HASH_DUPS" == "error" ]]; then
  echo "  ⚠ Could not check indep_hash uniqueness"
elif [[ "$INDEP_HASH_DUPS" == "0" ]]; then
  echo "  ✓ All block indep_hashes are unique"
else
  echo "  ✗ Found $INDEP_HASH_DUPS duplicate indep_hashes"
fi

# Check for duplicate transaction IDs
echo "  Checking transaction ID uniqueness..."
DUPLICATE_TXS=$(duckdb -csv -noheader -c "
  WITH tx_counts AS (
    SELECT id, COUNT(*) as cnt
    FROM read_parquet('$EXPORT_DIR/transactions/data/*/*.parquet', hive_partitioning=false)
    WHERE id IS NOT NULL
    GROUP BY id
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*) FROM tx_counts;
" 2>/dev/null || echo "error")

if [[ "$DUPLICATE_TXS" == "error" ]]; then
  echo "  ⚠ Could not check for duplicate transactions"
elif [[ "$DUPLICATE_TXS" == "0" ]]; then
  echo "  ✓ All transaction IDs are unique"
else
  echo "  ✗ Found $DUPLICATE_TXS duplicate transaction IDs"
fi

# Show uniqueness statistics
echo
echo "  Uniqueness Statistics:"
UNIQUE_STATS=$(duckdb -csv -noheader -c "
  WITH block_stats AS (
    SELECT 
      COUNT(*) as total_blocks,
      COUNT(DISTINCT height) as unique_heights,
      COUNT(DISTINCT hash) as unique_hashes,
      COUNT(DISTINCT indep_hash) as unique_indep_hashes
    FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false)
  ),
  tx_stats AS (
    SELECT 
      COUNT(*) as total_txs,
      COUNT(DISTINCT id) as unique_ids
    FROM read_parquet('$EXPORT_DIR/transactions/data/*/*.parquet', hive_partitioning=false)
  )
  SELECT 
    b.total_blocks,
    b.unique_heights,
    b.unique_hashes,
    b.unique_indep_hashes,
    t.total_txs,
    t.unique_ids
  FROM block_stats b, tx_stats t;
" 2>/dev/null || echo "error,error,error,error,error,error")

if [[ "$UNIQUE_STATS" != *"error"* ]]; then
  IFS=',' read -r total_blocks unique_heights unique_hashes unique_indep_hashes total_txs unique_ids <<< "$UNIQUE_STATS"
  echo "    Blocks: $total_blocks total, $unique_heights unique heights"
  echo "    Block hashes: $unique_hashes unique (should equal $total_blocks)"
  echo "    Block indep_hashes: $unique_indep_hashes unique (should equal $total_blocks)"
  echo "    Transactions: $total_txs total, $unique_ids unique IDs"
fi

# 7. Check block tx_count accuracy (if L1 transactions included)
echo
echo "7. Block tx_count Validation:"
echo "-----------------------------"
# First check if we have any L1 transactions
HAS_L1_TX=$(duckdb -csv -noheader -c "
  SELECT COUNT(*) FROM read_parquet('$EXPORT_DIR/transactions/data/*/*.parquet', hive_partitioning=false)
  WHERE is_data_item = 0 OR is_data_item IS NULL;
" 2>/dev/null || echo "0")

if [[ "$HAS_L1_TX" != "0" ]] && [[ "$HAS_L1_TX" != "error" ]]; then
  MISMATCHED_COUNTS=$(duckdb -csv -noheader -c "
    WITH block_counts AS (
      SELECT height, tx_count
      FROM read_parquet('$EXPORT_DIR/blocks/data/*/*.parquet', hive_partitioning=false)
    ),
    actual_counts AS (
      SELECT height, COUNT(*) as actual_tx_count
      FROM read_parquet('$EXPORT_DIR/transactions/data/*/*.parquet', hive_partitioning=false)
      WHERE is_data_item = 0
      GROUP BY height
    )
    SELECT COUNT(*)
    FROM block_counts b
    LEFT JOIN actual_counts a ON b.height = a.height
    WHERE b.tx_count != COALESCE(a.actual_tx_count, 0);
  " 2>/dev/null || echo "unknown")
  
  if [[ "$MISMATCHED_COUNTS" == "0" ]]; then
    echo "  ✓ Block tx_count matches actual L1 transaction counts"
  elif [[ "$MISMATCHED_COUNTS" == "unknown" ]] || [[ "$MISMATCHED_COUNTS" == "error" ]]; then
    echo "  ⚠ Could not verify tx_count"
  else
    echo "  ✗ Found $MISMATCHED_COUNTS blocks with incorrect tx_count"
  fi
else
  echo "  ⚠ No L1 transactions found (may not be included in export)"
fi

# 8. Summary statistics
echo
echo "8. Export Statistics:"
echo "--------------------"
for table in blocks transactions tags; do
  if [[ -d "$EXPORT_DIR/$table/data" ]]; then
    TOTAL_ROWS=$(duckdb -csv -noheader -c "
      SELECT COUNT(*) FROM read_parquet('$EXPORT_DIR/$table/data/*/*.parquet', hive_partitioning=false);
    " 2>/dev/null || echo "0")
    
    TOTAL_SIZE=$(du -sh "$EXPORT_DIR/$table" | cut -f1)
    PARTITION_COUNT=$(find "$EXPORT_DIR/$table/data" -mindepth 1 -maxdepth 1 -type d | wc -l)
    FILE_COUNT=$(find "$EXPORT_DIR/$table/data" -name "*.parquet" | wc -l)
    
    echo "  $table:"
    echo "    Rows: $TOTAL_ROWS"
    echo "    Partitions: $PARTITION_COUNT"
    echo "    Files: $FILE_COUNT"
    echo "    Size: $TOTAL_SIZE"
  fi
done

echo
echo "Integrity check complete!"