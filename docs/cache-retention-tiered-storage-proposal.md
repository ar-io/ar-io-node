# Tiered Storage for Cache Retention Policies

## Overview

This proposal extends the cache retention policy feature to support storing retained data in a separate location from regular cached data, enabling tiered storage strategies.

## Use Cases

1. **Performance Optimization**: Store frequently accessed retained data on NVMe SSDs while keeping regular cache on HDDs
2. **Cost Optimization**: Use cloud storage for long-term retained data while keeping short-term cache local
3. **Backup Strategy**: Different backup policies for retained vs temporary cached data
4. **Capacity Management**: Separate storage pools with different capacity limits

## Proposed Implementation

### 1. New Environment Variables

```bash
# Path for data with retention policies (defaults to regular path if not set)
RETENTION_DATA_PATH=/mnt/fast-storage/retained-data

# Optional: Move existing retained data during migration
MIGRATE_RETAINED_DATA=true
```

### 2. Storage Strategy

#### Option A: Composite Data Store (Recommended)

Create a new `TieredFsDataStore` that:
- Checks if data has a retention policy when writing
- Routes to appropriate storage location
- Reads from both locations transparently

```typescript
class TieredFsDataStore implements DataStore {
  constructor(
    private regularStore: FsDataStore,
    private retentionStore: FsDataStore,
    private db: DataContentIndexDatabase
  ) {}

  async finalize(data: AsyncIterable<Buffer>, hash: string): Promise<void> {
    // Check if this hash has a retention policy
    const retention = await this.db.getDataRetention(hash);
    const store = retention?.retentionPolicyId ? this.retentionStore : this.regularStore;
    return store.finalize(data, hash);
  }

  async get(hash: string, options?: GetDataOptions): Promise<Readable | undefined> {
    // Try retention store first, then regular store
    const retentionData = await this.retentionStore.get(hash, options);
    if (retentionData) return retentionData;
    return this.regularStore.get(hash, options);
  }
}
```

#### Option B: Symlink Approach

- Store all data in regular location initially
- Create symlinks in retention path for retained data
- Simpler but less flexible

### 3. Migration Strategy

For existing deployments:

1. On startup, check for retained data in old location
2. Move or symlink retained files to new location
3. Update database with migration status

### 4. Cleanup Worker Updates

The cleanup worker would need to:
- Check both storage locations
- Only delete from the appropriate location
- Handle the case where data might exist in both locations during migration

### 5. Configuration Examples

#### Example 1: Fast SSD for Retained Data
```bash
DATA_PATH=/mnt/hdd/ar-io/data/contiguous
RETENTION_DATA_PATH=/mnt/nvme/ar-io/retained-data
```

#### Example 2: Cloud Storage for Long-term Retention
```bash
DATA_PATH=/local/cache
AWS_S3_RETENTION_DATA_BUCKET=my-retained-data-bucket
```

## Benefits

1. **Performance**: Frequently accessed retained data on faster storage
2. **Cost**: Optimize storage costs based on retention requirements  
3. **Flexibility**: Different storage backends for different data classes
4. **Scalability**: Can add more storage tiers in the future

## Considerations

1. **Complexity**: Adds another configuration option
2. **Migration**: Need to handle existing deployments gracefully
3. **Monitoring**: Should expose metrics for both storage locations
4. **Backup**: May need different backup strategies per tier

## Implementation Priority

1. Basic tiered storage with filesystem (Option A)
2. Migration tooling for existing data
3. S3 support for retention tier
4. Multiple tier support (hot/warm/cold)