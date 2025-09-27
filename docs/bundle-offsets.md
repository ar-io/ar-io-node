# Bundle Offsets in AR.IO Node

This document provides a comprehensive technical reference for understanding offset relationships in the AR.IO Node system, particularly in the context of ANS-104 bundles and Turbo integration.

## Introduction and Context

Offsets are critical for efficient data retrieval in the Arweave ecosystem, especially when dealing with nested ANS-104 bundles. The AR.IO Node must be able to:

1. **Locate data items** within potentially deep bundle hierarchies
2. **Calculate absolute positions** within root L1 transactions
3. **Cache offset information** to avoid repeated calculations
4. **Integrate with Turbo** for enhanced offset discovery

The [ANS-104 bundle format](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md) allows data items to be nested within other data items, creating hierarchical structures that require careful offset tracking to navigate efficiently.

## Turbo API `/offsets` Endpoint Response Fields

The Turbo API provides rich offset information through its `/tx/{id}/offsets` endpoint. Understanding these fields is crucial for implementing efficient data retrieval.

### Core Fields (Always Present)

These fields are returned for every data item, regardless of its position in the bundle hierarchy:

- **`rawContentLength`**: Total size of the data item including all headers and payload data
- **`payloadContentType`**: MIME type of the data item's actual content (e.g., "application/json", "image/png")
- **`payloadDataStart`**: Byte position where the actual data payload begins within the data item (after headers, signature, owner, tags, etc.)
- **`payloadContentLength`**: Size of just the payload data, excluding all headers and metadata

### Hierarchical Fields (Context-Dependent)

These fields describe the data item's position within the bundle hierarchy:

- **`parentDataItemId`**: ID of the parent bundle containing this data item. Set to `null` for L1 transactions that are not contained within any bundle.
- **`rootBundleId`**: ID of the root L1 transaction containing this item. Set to `null` if this data item IS the root transaction.
- **`startOffsetInParentDataItemPayload`**: Position of this data item within its parent's payload section. Only meaningful when `parentDataItemId` is present.
- **`startOffsetInRootBundle`**: Position of this data item within the root bundle's payload. Only set when `rootBundleId` is present and this item is a direct child of the root.

### Example Response

```json
{
  "parentDataItemId": "bundle-abc123",
  "rootBundleId": "root-tx-def456",
  "startOffsetInParentDataItemPayload": 1024,
  "startOffsetInRootBundle": 2048,
  "rawContentLength": 512,
  "payloadContentType": "application/json",
  "payloadDataStart": 128,
  "payloadContentLength": 384
}
```

## Database Offset Fields in `contiguous_data_ids` Table

The AR.IO Node database stores various offset-related fields to enable efficient data retrieval without requiring external API calls.

### Existing Fields

- **`offset`**: Position of the data item within its immediate parent bundle
- **`data_offset`**: Position where the data payload starts within the parent bundle
- **`data_item_offset`**: Offset of the data item header within its parent bundle
- **`data_item_size`**: Total size of the data item (equivalent to Turbo's `rawContentLength`)
- **`root_parent_offset`**: Offset of the parent bundle's data payload relative to the root transaction
- **`root_transaction_id`**: The L1 transaction ID containing this data item

### New Fields (Added in this Implementation)

- **`root_data_item_offset`**: Absolute position of the data item within the root bundle. This is the byte position where the data item's headers begin within the root L1 transaction.
- **`root_data_offset`**: Absolute position of the data payload within the root bundle. This is the byte position where the actual content begins within the root L1 transaction.

These new fields enable direct chunk retrieval without traversing the bundle hierarchy each time.

## Offset Calculation Algorithm

### Chain Traversal for Nested Bundles

When Turbo provides offset information for nested bundles, the AR.IO Node must traverse the chain of parent relationships to calculate absolute positions:

```typescript
// Simplified algorithm from TurboRootTxIndex.calculateRootPosition
function calculateRootPosition(chain: TurboOffsetsResponse[]): OffsetResult {
  // The last item in chain has rootBundleId
  const rootItem = chain[chain.length - 1];
  let rootOffset = rootItem.startOffsetInRootBundle;

  // Walk back down the chain from parent to child
  for (let i = chain.length - 2; i >= 0; i--) {
    const parent = chain[i + 1];
    const child = chain[i];

    // Add parent's payload start to get into its payload
    rootOffset += parent.payloadDataStart;
    // Add child's position within parent's payload
    rootOffset += child.startOffsetInParentDataItemPayload;
  }

  // Calculate data offset
  const originalItem = chain[0];
  const rootDataOffset = rootOffset + originalItem.payloadDataStart;

  return { rootOffset, rootDataOffset };
}
```

### Visual Example: Multi-Level Nesting

```
Root Transaction (L1) - ID: root-tx-123
├─ Transaction Headers (1024 bytes)
├─ Bundle A Payload (starts at byte 1024)
│  ├─ Bundle A Headers (512 bytes)
│  ├─ Bundle A Data Items (starts at byte 1536)
│  │  ├─ Data Item 1 (256 bytes)
│  │  └─ Bundle B (starts at byte 1792)
│  │     ├─ Bundle B Headers (256 bytes)
│  │     ├─ Bundle B Data Items (starts at byte 2048)
│  │     │  └─ Target Data Item (starts at byte 2048)
│  │     │     ├─ Item Headers (128 bytes)
│  │     │     └─ Item Payload (starts at byte 2176)

Calculation for Target Data Item:
1. Bundle B.startOffsetInRootBundle = 1536 (Bundle A's data start)
2. Add Bundle A.payloadDataStart = 512 (to enter Bundle A's payload)
3. Add Target.startOffsetInParentDataItemPayload = 0 (first item in Bundle B)
4. root_data_item_offset = 1536 + 512 + 0 = 2048
5. root_data_offset = 2048 + 128 = 2176
```

### Attribute-Based Traversal

When Turbo data is unavailable, the AR.IO Node can traverse using database attributes:

```typescript
// Simplified algorithm from RootParentDataSource.traverseToRootUsingAttributes
async function traverseToRootUsingAttributes(dataItemId: string): Promise<OffsetResult> {
  let currentId = dataItemId;
  let totalOffset = 0;
  let originalItemDataOffset: number;

  while (true) {
    const attributes = await getDataAttributes(currentId);

    if (!attributes.parentId) {
      // This is the root - return accumulated offset
      return {
        rootTxId: currentId,
        totalOffset,
        rootDataOffset: totalOffset + originalItemDataOffset
      };
    }

    // Remember original item's data offset
    if (originalItemDataOffset === undefined) {
      originalItemDataOffset = attributes.dataOffset ?? 0;
    }

    // Add this item's offset and parent's root offset
    totalOffset += attributes.offset;
    totalOffset += attributes.rootParentOffset ?? 0;

    currentId = attributes.parentId;
  }
}
```

## Data Flow and Storage

### Turbo Integration Workflow

1. **Query Turbo**: `TurboRootTxIndex.getRootTxId()` calls `/tx/{id}/offsets`
2. **Chain Following**: For nested items, follow `parentDataItemId` to build complete chain
3. **Offset Calculation**: Use `calculateRootPosition()` to compute absolute offsets
4. **Result Return**: Provide `rootTxId`, `rootOffset`, and `rootDataOffset`
5. **Storage**: Call `setDataAttributes()` to persist calculated offsets

### Attribute Traversal Workflow

1. **Database Query**: `RootParentDataSource.traverseToRootUsingAttributes()` reads local data
2. **Parent Following**: Follow `parentId` relationships through the database
3. **Offset Accumulation**: Sum offsets at each level of the hierarchy
4. **Storage**: Call `setDataAttributes()` to persist discovered offsets

### Persistent Storage Strategy

Both workflows result in storing the calculated offsets via `setDataAttributes()`:

```typescript
await this.dataAttributesSource.setDataAttributes(id, {
  rootDataItemOffset: rootResult.rootOffset,
  rootDataOffset: rootResult.rootDataOffset,
});
```

This enables future requests for the same data item to skip the calculation entirely.

## Use Cases and Scenarios

### Scenario 1: Direct L1 Transaction

The simplest case where a transaction is stored directly on Arweave without being bundled:

```
L1 Transaction: tx-abc123
├─ Transaction Headers (1024 bytes)
└─ Transaction Data (2048 bytes)

Offsets:
- root_data_item_offset: 0 (this IS the root)
- root_data_offset: 1024 (after headers)
```

### Scenario 2: Single-Level Bundle

A data item contained directly within an L1 bundle transaction:

```
L1 Bundle Transaction: bundle-def456
├─ Bundle Headers (512 bytes)
├─ Data Item Index (256 bytes)
├─ Data Item 1 (starts at 768)
│  ├─ Item Headers (128 bytes)
│  └─ Item Payload (starts at 896)
└─ Data Item 2...

Data Item 1 Offsets:
- root_data_item_offset: 768
- root_data_offset: 896
```

### Scenario 3: Multi-Level Nesting

A data item within a bundle that is itself within another bundle:

```
L1 Transaction: root-ghi789
├─ Headers (1024 bytes)
├─ Bundle A (starts at 1024)
│  ├─ Headers (512 bytes)
│  ├─ Data Items (starts at 1536)
│  │  └─ Bundle B (starts at 1536)
│  │     ├─ Headers (256 bytes)
│  │     ├─ Data Items (starts at 1792)
│  │     │  └─ Target Item (starts at 1792)
│  │     │     ├─ Headers (64 bytes)
│  │     │     └─ Payload (starts at 1856)

Target Item Offsets:
- root_data_item_offset: 1792
- root_data_offset: 1856
```

### Scenario 4: Edge Cases

#### Circular References
The system detects and prevents infinite loops:
```typescript
const visited = new Set<string>();
if (visited.has(currentId)) {
  log.warn('Circular reference detected', { id, circularId: currentId });
  return undefined;
}
```

#### Maximum Nesting Depth
Prevents stack overflow with reasonable limits:
```typescript
const MAX_DEPTH = 10;
if (depth >= MAX_DEPTH) {
  log.warn('Maximum nesting depth reached', { id, depth });
  return undefined;
}
```

#### Missing Parent Data
Graceful fallback when parent information is unavailable:
```typescript
if (!attributes) {
  log.debug('No attributes found, item may not be indexed');
  return undefined;
}
```

## Performance Implications

### Benefits of Storing Offsets

1. **Eliminates Repeated Traversals**: Once calculated, offsets are cached in the database
2. **Reduces External API Calls**: Fewer requests to Turbo for known items
3. **Enables Direct Chunk Retrieval**: Can request specific byte ranges immediately
4. **Improves Cache Hit Rates**: Related data items often share parent bundles

### Cache Strategy

The system employs multiple levels of caching:

1. **LRU Memory Cache**: Recent Turbo responses cached in memory
2. **Database Persistence**: Calculated offsets stored permanently
3. **Gradual Population**: Cache populated as items are accessed
4. **Separate Cache Types**: Different caches for different offset types

```typescript
// Separate caches for different data types
const turboOffsetsCache = new LRUCache<string, CachedTurboOffsets>({
  max: config.ROOT_TX_CACHE_MAX_SIZE,
  ttl: config.ROOT_TX_CACHE_TTL_MS,
});

const rootTxCache = new LRUCache<string, CachedParentBundle>({
  max: config.ROOT_TX_CACHE_MAX_SIZE,
  ttl: config.ROOT_TX_CACHE_TTL_MS,
});
```

## Implementation Details

### Key Files and Components

#### Turbo Integration
- **`src/discovery/turbo-root-tx-index.ts`**: Main integration with Turbo API
  - Handles `/offsets` endpoint requests
  - Implements chain traversal logic
  - Manages caching and error handling

#### Attribute Traversal
- **`src/data/root-parent-data-source.ts`**: Database-based offset calculation
  - Implements attribute-based traversal
  - Stores discovered offsets via `setDataAttributes`
  - Handles fallback when Turbo is unavailable

#### Database Layer
- **`src/database/sql/data/content-attributes.sql`**: SQL statements for offset operations
  - Insert/update statements for new offset fields
  - Query statements for offset retrieval
- **`src/database/standalone-sqlite.ts`**: Database implementation
  - Parameter binding for offset fields
  - Worker/main thread communication

#### Type Definitions
- **`src/types.d.ts`**: TypeScript interfaces
  - `ContiguousDataAttributes` interface updates
  - Offset field type definitions
- **`src/workers/data-content-attribute-importer.ts`**: Worker type definitions

### Error Handling Strategy

#### Network Failures
```typescript
// Retry configuration in TurboRootTxIndex
this.axiosInstance.defaults.raxConfig = {
  retry: requestRetryCount,
  statusCodesToRetry: [[100, 199], [429, 429], [500, 599]],
  onRetryAttempt: (error) => {
    log.debug('Retrying Turbo request', { attempt, status, url });
  },
};
```

#### Data Validation
```typescript
// Validate response data before processing
if (response.status === 200 && response.data !== null) {
  const offsets = response.data;
  // Process valid response
} else {
  log.debug('Unexpected response from Turbo', { status });
  return NOT_FOUND;
}
```

#### Graceful Degradation
```typescript
// Fall back to attribute traversal if Turbo fails
try {
  const attributesTraversal = await this.traverseToRootUsingAttributes(id);
  if (attributesTraversal) {
    return this.handleAttributesResult(attributesTraversal);
  }
} catch (error) {
  log.warn('Attribute traversal failed', { error: error.message });
}
```

## Database Schema Migration

The offset storage enhancement required a database migration to add the new fields:

```sql
-- Migration: 2025.09.27T14.50.37.data.add-root-offsets.sql
ALTER TABLE contiguous_data_ids ADD COLUMN root_data_item_offset INTEGER;
ALTER TABLE contiguous_data_ids ADD COLUMN root_data_offset INTEGER;
```

Key considerations:
- **Nullable Fields**: New fields are nullable to maintain compatibility
- **No Default Values**: Avoiding table rewrites by using NULL for missing data
- **Index Considerations**: May add indexes if query patterns require them

## Testing Considerations

### Unit Test Coverage

- **Offset Calculation Logic**: Test `calculateRootPosition` with various chain lengths
- **Edge Case Handling**: Circular references, maximum depth, missing data
- **Type Conversions**: Ensure proper handling of nullable vs required fields

### Integration Test Scenarios

- **Mock Turbo Responses**: Test with realistic API response data
- **Database Persistence**: Verify offset storage and retrieval
- **Cache Behavior**: Test LRU eviction and TTL expiration

### Performance Benchmarks

- **Cache Hit Rates**: Measure effectiveness of offset caching
- **API Call Reduction**: Compare calls before/after offset storage
- **Query Performance**: Ensure new fields don't slow down existing queries

## Glossary of Terms

**Absolute Offset**: The global byte position within the entire Arweave weave or within a root L1 transaction.

**Bundle Hierarchy**: The tree structure formed by ANS-104 bundles containing other bundles or data items.

**Chain Traversal**: The process of following parent relationships from a nested data item back to its root transaction.

**Data Item**: An individual piece of content within an ANS-104 bundle, identified by a unique ID.

**L1 Transaction**: A transaction stored directly on the Arweave blockchain, not contained within any bundle.

**Payload**: The actual content data of a data item, excluding headers, signatures, and metadata.

**Relative Offset**: A byte position calculated relative to the start of a parent container (bundle or transaction).

**Root Transaction**: The L1 transaction that ultimately contains a data item, potentially through multiple levels of bundles.

For additional terminology, see the main [project glossary](./glossary.md).

---

This document serves as the authoritative reference for understanding how AR.IO Node handles offsets in the context of ANS-104 bundles and Turbo integration. For implementation details, refer to the source code files mentioned throughout this document.