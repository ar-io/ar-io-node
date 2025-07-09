# Testing Cache Retention with Tiered Storage

## Test Status

All unit tests are passing:
- ✅ Cache Policy Evaluator: 9/9 tests passing
- ✅ Cache Policy Loader: 10/10 tests passing  
- ✅ Tiered FS Data Store: 12/12 tests passing

## How to Test This Feature

### 1. Basic Configuration Test

Create a test environment with the following setup:

```bash
# Create test directories
mkdir -p /tmp/ar-io-test/regular-cache
mkdir -p /tmp/ar-io-test/retained-data

# Set environment variables
export ENABLE_CUSTOM_CACHE_POLICIES=true
export CACHE_POLICY_CONFIG_PATH=./config/test-policies.json
export RETENTION_DATA_PATH=/tmp/ar-io-test/retained-data

# For testing, also set the regular data path
export DATA_PATH=/tmp/ar-io-test/regular-cache
```

### 2. Create Test Policies

Create `config/test-policies.json`:

```json
{
  "version": "1.0",
  "policies": [
    {
      "id": "test-app-retention",
      "name": "Test App 30-Day Retention",
      "enabled": true,
      "priority": 100,
      "retentionDays": 30,
      "filter": {
        "tags": [
          {
            "name": "App-Name",
            "value": "TestApp"
          }
        ]
      }
    },
    {
      "id": "test-wallet-retention",
      "name": "Test Wallet 7-Day Retention", 
      "enabled": true,
      "priority": 90,
      "retentionDays": 7,
      "filter": {
        "attributes": {
          "owner_address": "test-wallet-address-123"
        }
      }
    },
    {
      "id": "default-short",
      "name": "Default 1-Day Retention",
      "enabled": true,
      "priority": 10,
      "retentionDays": 1,
      "filter": {
        "always": true
      }
    }
  ]
}
```

### 3. Integration Testing Steps

#### Step 1: Start the Gateway
```bash
# Start the gateway with test configuration
yarn start
```

#### Step 2: Monitor Storage Locations
```bash
# Watch regular cache directory
watch -n 2 'ls -la /tmp/ar-io-test/regular-cache/data/*/*/'

# Watch retention directory  
watch -n 2 'ls -la /tmp/ar-io-test/retained-data/data/*/*/'
```

#### Step 3: Test Data Ingestion

Upload test data that matches different policies:

```bash
# Test data with TestApp tag (should go to retention storage)
curl -X POST http://localhost:4000/tx \
  -H "Content-Type: application/json" \
  -d '{
    "tags": [
      {"name": "App-Name", "value": "TestApp"},
      {"name": "Content-Type", "value": "text/plain"}
    ],
    "data": "This is test data for TestApp"
  }'

# Test data from specific wallet (should go to retention storage)
curl -X POST http://localhost:4000/tx \
  -H "Content-Type: application/json" \
  -H "X-Owner-Address: test-wallet-address-123" \
  -d '{
    "data": "This is test data from test wallet"
  }'

# Regular data (should go to regular cache)
curl -X POST http://localhost:4000/tx \
  -H "Content-Type: application/json" \
  -d '{
    "tags": [
      {"name": "App-Name", "value": "OtherApp"}
    ],
    "data": "This is regular cached data"
  }'
```

#### Step 4: Verify Storage Locations

Check where files are stored:

```bash
# Find files in retention storage
find /tmp/ar-io-test/retained-data -name "*" -type f | head -10

# Find files in regular cache
find /tmp/ar-io-test/regular-cache -name "*" -type f | head -10
```

#### Step 5: Test Data Retrieval

Retrieve data and verify it works regardless of storage location:

```bash
# Get data by transaction ID
curl http://localhost:4000/tx/{TRANSACTION_ID}

# The gateway should find the data regardless of which tier it's in
```

### 4. Performance Testing

#### Test Read Performance
```bash
# Create a script to measure read times from both tiers
cat > test-read-performance.sh << 'EOF'
#!/bin/bash

echo "Testing read performance..."

# Test reading from retention tier (assuming SSD)
time for i in {1..100}; do
  curl -s http://localhost:4000/tx/{RETENTION_TX_ID} > /dev/null
done

# Test reading from regular tier (assuming HDD)  
time for i in {1..100}; do
  curl -s http://localhost:4000/tx/{REGULAR_TX_ID} > /dev/null
done
EOF

chmod +x test-read-performance.sh
./test-read-performance.sh
```

### 5. Cleanup Worker Testing

Test that the cleanup worker respects retention policies:

```bash
# Temporarily set aggressive cleanup for testing
export CONTIGUOUS_DATA_CACHE_CLEANUP_THRESHOLD=0.1

# Create old test files
# ... create test files with different ages ...

# Run cleanup
yarn cleanup

# Verify retained files are NOT deleted
ls -la /tmp/ar-io-test/retained-data/data/*/*/

# Verify expired regular cache IS deleted
ls -la /tmp/ar-io-test/regular-cache/data/*/*/
```

### 6. Monitor Logs

Watch for tiered storage operations in logs:

```bash
# Look for tiered storage decisions
tail -f logs/ar-io-node.log | grep -E "retention tier|regular tier|Moving retained data"

# Example log entries:
# INFO: Storing retained data in retention tier { hash: "abc123...", policyId: "test-app-retention", expiresAt: 1234567890 }
# DEBUG: Found data in retention tier { hash: "abc123..." }
# DEBUG: Found data in regular tier { hash: "xyz789..." }
```

### 7. Database Verification

Check that retention information is properly stored:

```bash
# Connect to SQLite database
sqlite3 data/sqlite/data.db

# Check retention data
SELECT hash, retention_policy_id, retention_expires_at 
FROM contiguous_data 
WHERE retention_policy_id IS NOT NULL
LIMIT 10;

# Check retention index is working
EXPLAIN QUERY PLAN 
SELECT * FROM contiguous_data 
WHERE retention_expires_at > 1234567890;
```

### 8. Edge Case Testing

Test various edge cases:

```bash
# Test with no retention path set (should use regular storage)
unset RETENTION_DATA_PATH
# Restart and verify all data goes to regular storage

# Test with invalid retention path
export RETENTION_DATA_PATH=/nonexistent/path
# Should log errors but fall back gracefully

# Test with retention store full
# Fill up retention storage and verify fallback behavior
```

### 9. Migration Testing

Test the data migration capability:

```bash
# Start with data in regular storage
# Add a retention policy that matches existing data
# Run migration (would need to implement migration script)
# Verify data moves to retention storage
```

## Expected Results

1. **Storage Separation**: Data matching retention policies should be stored in `RETENTION_DATA_PATH`, other data in regular cache
2. **Transparent Reads**: Data retrieval should work regardless of storage location
3. **Performance**: Reads from retention tier (if on faster storage) should be noticeably faster
4. **Cleanup Behavior**: Cleanup worker should respect retention policies and not delete retained data until expired
5. **Logging**: Clear log entries showing storage decisions
6. **Fallback**: System should work normally even if retention storage is unavailable

## Troubleshooting

If tests fail, check:

1. **Permissions**: Ensure the process has write permissions to both storage paths
2. **Disk Space**: Ensure sufficient space in both storage locations
3. **Configuration**: Verify JSON syntax in cache policies file
4. **Database**: Check that migrations ran successfully
5. **Logs**: Look for errors in application logs

## Production Deployment Checklist

Before deploying to production:

- [ ] Test with production-like data volumes
- [ ] Verify storage paths have appropriate permissions and space
- [ ] Test failover behavior if retention storage becomes unavailable
- [ ] Monitor initial performance impact
- [ ] Have rollback plan ready
- [ ] Document storage paths for operations team
- [ ] Set up monitoring for both storage tiers