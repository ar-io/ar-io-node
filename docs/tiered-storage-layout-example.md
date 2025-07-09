# Tiered Storage Layout Example

## Storage Structure

### Without Tiered Storage (Current)
```
/opt/ar-io-node/
├── data/
│   └── contiguous/
│       └── data/
│           ├── ab/cd/abcd1234...  # All data mixed together
│           ├── ef/12/ef123456...
│           └── 34/56/3456789a...
```

### With Tiered Storage (Proposed)
```
# Regular cache (HDD)
/opt/ar-io-node/
├── data/
│   └── contiguous/
│       └── data/
│           ├── ab/cd/abcd1234...  # Regular cached data
│           └── 12/34/12345678...  # Short-term cache

# Retained data (SSD)
/mnt/fast-ssd/ar-io-retained/
└── data/
    ├── ef/12/ef123456...  # ArDrive 7-year retention
    ├── 78/9a/789abcde...  # VIP wallet data
    └── bc/de/bcdef012...  # Critical app data
```

## Real-World Example

### Gateway Operator Scenario

A gateway operator wants to:
1. Cache general data for 30 days on cheap storage
2. Keep ArDrive data for 7 years on reliable storage
3. Keep data from premium customers for 1 year on fast storage

### Configuration

```bash
# .env file
ENABLE_CUSTOM_CACHE_POLICIES=true
CACHE_POLICY_CONFIG_PATH=./config/cache-policies.json
RETENTION_DATA_PATH=/mnt/raid10-ssd/retained-data
```

```json
// cache-policies.json
{
  "version": "1.0",
  "policies": [
    {
      "id": "ardrive-long-term",
      "name": "ArDrive 7-Year Retention",
      "enabled": true,
      "priority": 100,
      "retentionDays": 2555,
      "filter": {
        "tags": [
          { "name": "App-Name", "value": "ArDrive" }
        ]
      }
    },
    {
      "id": "premium-customers",
      "name": "Premium Customer Data",
      "enabled": true,
      "priority": 90,
      "retentionDays": 365,
      "filter": {
        "or": [
          { "attributes": { "owner_address": "premium-wallet-1" } },
          { "attributes": { "owner_address": "premium-wallet-2" } }
        ]
      }
    }
  ]
}
```

### Storage Results

```
# Regular storage (2TB HDD RAID5)
/opt/ar-io-node/data/contiguous/
- 1.5TB of general cached data
- Automatically cleaned up after 30 days
- Can handle disk failures with RAID5

# Retention storage (500GB SSD RAID10)  
/mnt/raid10-ssd/retained-data/
- 300GB of ArDrive data (accumulated over time)
- 50GB of premium customer data
- Fast access for frequently requested retained data
- High reliability with RAID10
```

### Performance Benefits

1. **Read Performance**: 
   - Retained data: ~550MB/s (SSD)
   - Regular cache: ~150MB/s (HDD)

2. **Reliability**:
   - Retained data: RAID10 for critical data
   - Regular cache: RAID5 for cost efficiency

3. **Cost Optimization**:
   - 80% of data on cheap HDDs
   - 20% of important data on SSDs

### Monitoring Dashboard

```
Storage Tier Status:
┌─────────────────┬──────────┬───────────┬────────────┐
│ Tier            │ Used     │ Total     │ Percentage │
├─────────────────┼──────────┼───────────┼────────────┤
│ Regular Cache   │ 1.5 TB   │ 2.0 TB    │ 75%        │
│ Retention Tier  │ 350 GB   │ 500 GB    │ 70%        │
└─────────────────┴──────────┴───────────┴────────────┘

Policy Statistics:
┌──────────────────┬────────────┬──────────────┐
│ Policy           │ Files      │ Total Size   │
├──────────────────┼────────────┼──────────────┤
│ ardrive-long-term│ 125,000    │ 300 GB       │
│ premium-customers│ 15,000     │ 50 GB        │
│ (no policy)      │ 500,000    │ 1.5 TB       │
└──────────────────┴────────────┴──────────────┘
```