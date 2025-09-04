#!/usr/bin/env bash

echo "Testing Parquet Export with Timing Analysis"
echo "==========================================="
echo

# Clean up previous test data
rm -rf data/test-timing

# Test with timing enabled for a small range
./scripts/parquet-export-v3 \
  --startHeight 1718100 \
  --endHeight 1718105 \
  --heightPartitionSize 2 \
  --outputDir data/test-timing \
  --includeL1Transactions \
  --includeL1Tags \
  --showTiming \
  --verifyCount 2>&1 | tee timing-output.log

echo
echo "Timing Summary:"
echo "---------------"
grep "\[TIMING\]" timing-output.log | sort -t: -k2 -rn

echo
echo "Top 5 slowest operations:"
echo "-------------------------"
grep "\[TIMING\]" timing-output.log | sort -t: -k2 -rn | head -5

echo
echo "Import vs Export comparison:"
echo "---------------------------"
grep "\[TIMING\].*import" timing-output.log
echo "---"
grep "\[TIMING\].*export" timing-output.log

echo
echo "Row counts processed:"
echo "--------------------"
grep "\[TIMING\].*Imported:" timing-output.log
grep "Exported:" timing-output.log | grep -v "\[TIMING\]"