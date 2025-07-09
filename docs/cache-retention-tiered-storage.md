# Cache Retention Tiered Storage

## Overview

The ar.io gateway now supports tiered storage for cache retention policies. This allows gateway operators to store data matching retention policies on different storage tiers (e.g., fast SSDs for important data, regular HDDs for general cache).

## Configuration

### Environment Variables

```bash
# Enable custom cache retention policies
ENABLE_CUSTOM_CACHE_POLICIES=true

# Path to retention policy configuration
CACHE_POLICY_CONFIG_PATH=./config/cache-policies.json

# Path for retained data storage (optional)
# If not set, retained data uses the same storage as regular cache
RETENTION_DATA_PATH=/mnt/fast-storage/retained-data
```

### Example Configuration

```bash
# .env file
ENABLE_CUSTOM_CACHE_POLICIES=true
CACHE_POLICY_CONFIG_PATH=./config/cache-policies.json
RETENTION_DATA_PATH=/mnt/nvme-ssd/ar-io-retained
```

## How It Works

1. **Data Ingestion**: When data is cached, the system checks if it matches any retention policies
2. **Storage Decision**: 
   - Data with retention policies → Stored in `RETENTION_DATA_PATH`
   - Regular cached data → Stored in default location (`data/contiguous/`)
3. **Data Retrieval**: The system automatically checks both storage locations when retrieving data

## Storage Architecture

### Without Tiered Storage
```
/opt/ar-io-node/
└── data/
    └── contiguous/
        └── data/
            ├── ab/cd/abcd1234...  # All data mixed together
            └── ef/12/ef123456...
```

### With Tiered Storage
```
# Regular cache (HDD)
/opt/ar-io-node/
└── data/
    └── contiguous/
        └── data/
            └── ab/cd/abcd1234...  # Short-term cache

# Retained data (SSD)
/mnt/nvme-ssd/ar-io-retained/
└── data/
    ├── ef/12/ef123456...  # ArDrive 7-year retention
    └── 78/9a/789abcde...  # VIP wallet data
```

## Use Cases

### 1. Performance Optimization
Store frequently accessed retained data on NVMe SSDs while keeping bulk cache on HDDs:
```bash
RETENTION_DATA_PATH=/mnt/nvme/ar-io-retained
```

### 2. Reliability Enhancement
Use RAID10 for critical retained data and RAID5 for general cache:
```bash
# Mount points with different RAID levels
RETENTION_DATA_PATH=/mnt/raid10-ssd/retained  # High reliability
# Regular cache uses /data/contiguous (RAID5)  # Cost efficient
```

### 3. Cost Optimization
Use expensive fast storage only for data that needs long-term retention:
- 20% of data (retained) on SSDs
- 80% of data (regular cache) on HDDs

## Example Deployment

### Hardware Setup
- 2x 1TB NVMe SSDs in RAID1 for retained data
- 4x 4TB HDDs in RAID5 for regular cache

### Configuration
```json
// cache-policies.json
{
  "version": "1.0",
  "policies": [
    {
      "id": "critical-apps",
      "name": "Critical Application Data",
      "enabled": true,
      "priority": 100,
      "retentionDays": 3650,  // 10 years
      "filter": {
        "or": [
          { "tags": [{ "name": "App-Name", "value": "ArDrive" }] },
          { "tags": [{ "name": "App-Name", "value": "Akord" }] }
        ]
      }
    },
    {
      "id": "premium-users",
      "name": "Premium User Data",
      "enabled": true,
      "priority": 90,
      "retentionDays": 730,  // 2 years
      "filter": {
        "attributes": {
          "owner_address": "premium-wallet-address"
        }
      }
    }
  ]
}
```

### Environment
```bash
ENABLE_CUSTOM_CACHE_POLICIES=true
CACHE_POLICY_CONFIG_PATH=./config/cache-policies.json
RETENTION_DATA_PATH=/mnt/nvme-raid1/retained-data
```

## Monitoring

The tiered storage system logs information about storage decisions:

```
INFO: Storing retained data in retention tier {
  hash: "abc123...",
  policyId: "critical-apps",
  expiresAt: 1735689600000
}

DEBUG: Found data in retention tier { hash: "abc123..." }
DEBUG: Found data in regular tier { hash: "xyz789..." }
```

## Migration

The system includes a `migrateData()` method for moving data between tiers when policies change. This can be used for:
- Moving existing data to retention tier when new policies are added
- Moving data back to regular tier when retention expires
- Rebalancing storage when hardware changes

## Best Practices

1. **Plan Storage Capacity**: Ensure retention tier has enough space for long-term data
2. **Monitor Usage**: Track storage usage on both tiers
3. **Test Policies**: Test retention policies in staging before production
4. **Backup Strategy**: Consider different backup strategies for each tier
5. **Performance Testing**: Benchmark read performance from both tiers

## Technical Details

- Implementation: `TieredFsDataStore` class
- Implements standard `ContiguousDataStore` interface
- Transparent to the rest of the system
- Falls back gracefully if retention store unavailable