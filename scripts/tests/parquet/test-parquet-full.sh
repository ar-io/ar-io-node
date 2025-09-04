#!/usr/bin/env bash

# Full test script for parquet-export-v3 with larger data

set -e

echo "Full Parquet Export Test"
echo "========================"
echo

# Test parameters - using full data range
START_HEIGHT=1718100
END_HEIGHT=1718281
PARTITION_SIZE=20  # 20 blocks per partition (~10 partitions)

echo "Dataset information:"
echo "  Height range: $START_HEIGHT - $END_HEIGHT"
echo "  Total blocks: $((END_HEIGHT - START_HEIGHT + 1))"
echo "  Partition size: $PARTITION_SIZE blocks"
echo "  Expected partitions: $(( (END_HEIGHT - START_HEIGHT + PARTITION_SIZE) / PARTITION_SIZE ))"
echo

# Test 1: L2 data only (default)
echo "Test 1: Export L2 data only (default behavior)"
echo "----------------------------------------------"
TEST_OUTPUT_DIR="data/test-parquet-l2-only"
rm -rf "$TEST_OUTPUT_DIR"
mkdir -p "$TEST_OUTPUT_DIR"

START_TIME=$(date +%s)

./scripts/parquet-export-v3 \
  --startHeight "$START_HEIGHT" \
  --endHeight "$END_HEIGHT" \
  --heightPartitionSize "$PARTITION_SIZE" \
  --outputDir "$TEST_OUTPUT_DIR" \
  --verifyCount

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo
echo "Export completed in $DURATION seconds"
echo

# Check results
echo "L2-only export results:"
for table in blocks transactions tags; do
  if [[ -d "$TEST_OUTPUT_DIR/$table/data" ]]; then
    partition_count=$(find "$TEST_OUTPUT_DIR/$table/data" -mindepth 1 -maxdepth 1 -type d | wc -l)
    file_count=$(find "$TEST_OUTPUT_DIR/$table/data" -name "*.parquet" | wc -l)
    total_size=$(du -sh "$TEST_OUTPUT_DIR/$table" 2>/dev/null | cut -f1)
    echo "  $table: $partition_count partitions, $file_count files, $total_size total"
  fi
done

echo
echo "Test 2: Export with L1 data included"
echo "------------------------------------"
TEST_OUTPUT_DIR="data/test-parquet-l1-l2"
rm -rf "$TEST_OUTPUT_DIR"
mkdir -p "$TEST_OUTPUT_DIR"

START_TIME=$(date +%s)

./scripts/parquet-export-v3 \
  --startHeight "$START_HEIGHT" \
  --endHeight "$END_HEIGHT" \
  --heightPartitionSize "$PARTITION_SIZE" \
  --outputDir "$TEST_OUTPUT_DIR" \
  --includeL1Transactions \
  --includeL1Tags \
  --verifyCount

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo
echo "Export completed in $DURATION seconds"
echo

# Check results
echo "L1+L2 export results:"
for table in blocks transactions tags; do
  if [[ -d "$TEST_OUTPUT_DIR/$table/data" ]]; then
    partition_count=$(find "$TEST_OUTPUT_DIR/$table/data" -mindepth 1 -maxdepth 1 -type d | wc -l)
    file_count=$(find "$TEST_OUTPUT_DIR/$table/data" -name "*.parquet" | wc -l)
    total_size=$(du -sh "$TEST_OUTPUT_DIR/$table" 2>/dev/null | cut -f1)
    echo "  $table: $partition_count partitions, $file_count files, $total_size total"
    
    # Sample a partition to check row counts
    if [[ "$table" == "transactions" ]]; then
      first_partition=$(find "$TEST_OUTPUT_DIR/$table/data" -mindepth 1 -maxdepth 1 -type d | head -1)
      if [[ -n "$first_partition" ]]; then
        sample_count=$(duckdb -csv -noheader -c "
          SELECT COUNT(*) FROM read_parquet('$first_partition/*.parquet');
        " 2>/dev/null || echo "0")
        echo "    Sample partition $(basename "$first_partition"): $sample_count rows"
      fi
    fi
  fi
done

echo
echo "Test 3: Test resumable export (interrupt and resume)"
echo "----------------------------------------------------"
TEST_OUTPUT_DIR="data/test-parquet-resume"
rm -rf "$TEST_OUTPUT_DIR"
mkdir -p "$TEST_OUTPUT_DIR"

# Start export but interrupt it after 5 seconds
echo "Starting export (will interrupt after 5 seconds)..."
timeout 5 ./scripts/parquet-export-v3 \
  --startHeight "$START_HEIGHT" \
  --endHeight "$END_HEIGHT" \
  --heightPartitionSize "$PARTITION_SIZE" \
  --outputDir "$TEST_OUTPUT_DIR" \
  --includeL1Transactions \
  --includeL1Tags || true

echo "Export interrupted. Checking staging..."
STAGING_JOB=$(ls -dt data/staging/job-* 2>/dev/null | head -1)
if [[ -n "$STAGING_JOB" ]]; then
  echo "  Found staging job: $(basename "$STAGING_JOB")"
  echo "  Staging contents:"
  ls -la "$STAGING_JOB" | head -10
fi

echo
echo "Resuming export..."
./scripts/parquet-export-v3 \
  --startHeight "$START_HEIGHT" \
  --endHeight "$END_HEIGHT" \
  --heightPartitionSize "$PARTITION_SIZE" \
  --outputDir "$TEST_OUTPUT_DIR" \
  --includeL1Transactions \
  --includeL1Tags \
  --resume

echo
echo "Resume test results:"
for table in blocks transactions tags; do
  if [[ -d "$TEST_OUTPUT_DIR/$table/data" ]]; then
    partition_count=$(find "$TEST_OUTPUT_DIR/$table/data" -mindepth 1 -maxdepth 1 -type d | wc -l)
    echo "  $table: $partition_count partitions"
  fi
done

echo
echo "All tests completed!"
echo
echo "Summary:"
echo "--------"
echo "1. L2-only export: Check data/test-parquet-l2-only/"
echo "2. L1+L2 export: Check data/test-parquet-l1-l2/"
echo "3. Resumable export: Check data/test-parquet-resume/"