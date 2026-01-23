# CDB64 File Format Specification

CDB64 is a 64-bit variant of D. J. Bernstein's [Constant Database (CDB)](https://cr.yp.to/cdb.html) format. It provides O(1) key-value lookups with minimal overhead, designed for static datasets that are written once and read many times.

## Overview

CDB64 extends the original CDB format to support files larger than 4GB by using 64-bit file offsets instead of 32-bit. This is necessary for large historical indexes that can exceed the 4GB limit.

### Key Characteristics

- **Immutable**: Files are written once and never modified
- **O(1) Lookups**: Constant-time key lookups via hash tables
- **Compact**: Minimal overhead per record
- **Simple**: Easy to implement in any language
- **Portable**: Little-endian byte order, no alignment requirements

## File Structure

A CDB64 file consists of three sections in order:

```
+------------------+
|      Header      |  4096 bytes (256 × 16-byte pointers)
+------------------+
|     Records      |  Variable length
+------------------+
|   Hash Tables    |  Variable length (256 tables)
+------------------+
```

### Header (4096 bytes)

The header contains 256 table pointers, one for each possible value of the low 8 bits of a hash. Each pointer is 16 bytes:

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 8 | uint64_le | Table position (byte offset from start of file) |
| 8 | 8 | uint64_le | Table length (number of slots, not bytes) |

Total header size: 256 × 16 = 4096 bytes

### Records

Records are stored sequentially starting at byte offset 4096. Each record has the format:

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 8 | uint64_le | Key length in bytes |
| 8 | 8 | uint64_le | Value length in bytes |
| 16 | key_length | bytes | Key data |
| 16 + key_length | value_length | bytes | Value data |

Records have no padding or alignment requirements.

### Hash Tables

After all records, the file contains 256 hash tables. Each table has a variable number of slots (stored in the header). Each slot is 16 bytes:

| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 8 | uint64_le | Full 64-bit hash of the key |
| 8 | 8 | uint64_le | Record position (0 if slot is empty) |

The number of slots in each table is always 2× the number of records that hash to that table (for efficient linear probing).

## Hash Function

CDB64 uses the DJB hash function (same as original CDB), computed with 64-bit arithmetic:

```
hash = 5381
for each byte in key:
    hash = ((hash << 5) + hash) ^ byte
    hash = hash & 0xFFFFFFFFFFFFFFFF  // Keep as 64-bit unsigned
```

The hash is used in two ways:
1. `hash % 256` → Selects which of the 256 tables to use
2. `(hash / 256) % table_length` → Starting slot within that table

## Lookup Algorithm

To look up a key:

1. Compute `hash = djb_hash(key)` (64-bit)
2. Select table: `table_index = hash % 256`
3. Read table pointer from header at offset `table_index × 16`
4. If table length is 0, key is not present
5. Compute starting slot: `slot = (hash / 256) % table_length`
6. Linear probe:
   - Read slot at `table_position + slot × 16`
   - If slot position is 0, key is not present
   - If slot hash matches and key matches, return value
   - Otherwise: `slot = (slot + 1) % table_length`, repeat

## Writing Algorithm

To create a CDB64 file:

1. Skip header (write 4096 zero bytes or seek past it)
2. For each key-value pair:
   - Write record (key_len, value_len, key, value)
   - Remember: `{ hash, position }` for each record
   - Group records by `hash % 256`
3. For each of the 256 tables:
   - Table length = 2 × number of records in this table
   - Create slots array initialized to `{ hash: 0, position: 0 }`
   - For each record in this table:
     - Starting slot = `(hash / 256) % table_length`
     - Linear probe to find empty slot (position == 0)
     - Store `{ hash, position }` in slot
   - Write all slots
   - Record table position and length
4. Seek to beginning, write header with table pointers

## Differences from Original CDB

| Aspect | Original CDB | CDB64 |
|--------|--------------|-------|
| Header pointer size | 8 bytes (4+4) | 16 bytes (8+8) |
| Header total size | 2048 bytes | 4096 bytes |
| Record header size | 8 bytes (4+4) | 16 bytes (8+8) |
| Hash table slot size | 8 bytes (4+4) | 16 bytes (8+8) |
| Hash value | 32-bit | 64-bit |
| Key/value length fields | 32-bit | 64-bit |
| Position fields | 32-bit | 64-bit |
| Maximum file size | 4 GB | 16 EB (practical: unlimited) |

The hash function algorithm is identical (DJB hash), but computed with 64-bit arithmetic.

---

# Root TX Index Value Format

For the AR.IO Gateway's root TX index, CDB64 keys and values have specific formats.

## Key Format

Keys are 32-byte data item IDs (binary, not base64-encoded):

```
Key: <32 bytes> - Raw data item ID
```

## Value Format

Values are MessagePack-encoded objects with short keys for compactness. Four formats are supported to handle both legacy data and nested bundle hierarchies.

### Legacy Formats

#### Simple Format

Used when only the root transaction ID is known:

```javascript
{
  r: <Buffer 32 bytes>  // Root transaction ID (binary)
}
```

#### Complete Format

Used when offset information is available:

```javascript
{
  r: <Buffer 32 bytes>,  // Root transaction ID (binary)
  i: <integer>,          // Root data item offset (byte offset of data item header)
  d: <integer>           // Root data offset (byte offset of data payload)
}
```

### Path Formats

Path formats are used for nested bundles (bundles containing bundles). The path array provides the traversal route from the L1 root transaction through intermediate bundles to the immediate parent bundle.

#### Path Format

Used when the bundle traversal path is known but offsets are not:

```javascript
{
  p: [<Buffer 32 bytes>, ...]  // Array of bundle IDs from root to parent
}
```

#### Path Complete Format

Used when both path and offset information are available:

```javascript
{
  p: [<Buffer 32 bytes>, ...],  // Array of bundle IDs from root to parent
  i: <integer>,                  // Root data item offset
  d: <integer>                   // Root data offset
}
```

### Path Structure

The path array contains transaction/data item IDs representing the bundle hierarchy:

- `path[0]` is always the L1 root transaction ID
- `path[1..n-1]` are intermediate nested bundle IDs (if any)
- `path[n-1]` (last element) is the immediate parent bundle containing the data item
- The data item ID itself is NOT included in the path

**Example path for a deeply nested data item:**
```
Root TX → Bundle A → Bundle B → Data Item
path = [RootTxId, BundleAId, BundleBId]
```

For path formats, the root TX ID is derived from `path[0]`, eliminating the need for a separate `r` field.

### Field Mapping

| MessagePack Key | Full Name | Description |
|-----------------|-----------|-------------|
| `r` | rootTxId | 32-byte root transaction ID (legacy formats only) |
| `p` | path | Array of 32-byte bundle IDs [root, ..., parent] |
| `i` | rootDataItemOffset | Byte offset of nested data item within root TX |
| `d` | rootDataOffset | Byte offset of data payload within root TX |

These offsets correspond to the HTTP headers:
- `i` → `X-AR-IO-Root-Data-Item-Offset`
- `d` → `X-AR-IO-Root-Data-Offset`

### Maximum Nesting Depth

The path array is limited to a maximum of 10 elements (`MAX_BUNDLE_NESTING_DEPTH`), which supports bundle nesting up to 9 levels deep (root TX + 9 nested bundles).

## Examples

### Legacy Complete Format

For a data item `abc123...` nested directly in root TX `xyz789...` at offset 1024 with data at offset 1536:

**Key** (32 bytes):
```
abc123... (raw binary data item ID)
```

**Value** (MessagePack encoded):
```javascript
{
  r: Buffer<xyz789...>,  // 32 bytes
  i: 1024,
  d: 1536
}
```

**Encoded size**: ~40-45 bytes depending on offset values

### Path Complete Format

For a data item `def456...` nested inside Bundle B (`bbb...`) which is inside Bundle A (`aaa...`) which is inside root TX `xyz789...`:

**Key** (32 bytes):
```
def456... (raw binary data item ID)
```

**Value** (MessagePack encoded):
```javascript
{
  p: [
    Buffer<xyz789...>,  // Root TX ID (32 bytes)
    Buffer<aaa...>,     // Bundle A ID (32 bytes)
    Buffer<bbb...>      // Bundle B ID - immediate parent (32 bytes)
  ],
  i: 5000,
  d: 5512
}
```

**Encoded size**: ~110-115 bytes for 3-element path with offsets

---

# Implementation Notes

## File Creation

CDB64 files should be created atomically:
1. Write to a temporary file (e.g., `output.cdb.tmp.{pid}`)
2. Rename to final path after completion

This ensures readers never see partial files.

## Concurrency

- Multiple readers can safely read the same file concurrently
- Writers should use exclusive access during creation
- Files are immutable after creation - no locking needed for reads

## Memory Usage

The reader only needs to keep the 4096-byte header in memory. All lookups are done via direct file seeks, making it suitable for very large files.

## Error Handling

- Invalid files can be detected by checking if table positions are within file bounds
- Corrupted records can be detected by checking if key/value lengths are reasonable
- Hash collisions are handled correctly by the linear probing algorithm

---

# Partitioned CDB64 Index Format

For very large indexes, CDB64 files can be partitioned by key prefix into up to 256 separate files. This enables:

- **Manageable file sizes**: Each partition contains only keys with a specific first byte
- **Parallel I/O**: Different partitions can be accessed concurrently
- **Lazy loading**: Only open partitions that are actually accessed
- **Flexible storage**: Partitions can be stored locally, on HTTP servers, or on Arweave

## Directory Structure

A partitioned index consists of a directory containing:

```
index/
  manifest.json    # Index manifest with partition metadata
  00.cdb           # Records with keys starting 0x00
  01.cdb           # Records with keys starting 0x01
  ...
  ff.cdb           # Records with keys starting 0xff
```

Not all 256 partition files need to exist - only partitions that contain records are created.

## Manifest Format

The `manifest.json` file describes the partitioned index:

```json
{
  "version": 1,
  "createdAt": "2025-01-15T12:00:00.000Z",
  "totalRecords": 1000000,
  "partitions": [
    {
      "prefix": "00",
      "location": { "type": "file", "filename": "00.cdb" },
      "recordCount": 3921,
      "size": 245760,
      "sha256": "abc123..."
    },
    {
      "prefix": "01",
      "location": { "type": "file", "filename": "01.cdb" },
      "recordCount": 3847,
      "size": 241664
    }
  ],
  "metadata": {
    "source": "custom metadata"
  }
}
```

### Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | integer | Yes | Manifest format version (currently 1) |
| `createdAt` | string | Yes | ISO 8601 creation timestamp |
| `totalRecords` | integer | Yes | Total records across all partitions |
| `partitions` | array | Yes | List of partition descriptors |
| `metadata` | object | No | Optional custom metadata |

### Partition Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prefix` | string | Yes | Two-character lowercase hex prefix ("00" - "ff") |
| `location` | object | Yes | Location descriptor (see below) |
| `recordCount` | integer | Yes | Number of records in this partition |
| `size` | integer | Yes | File size in bytes |
| `sha256` | string | No | SHA-256 hash for integrity verification |

### Location Types

Partitions support flexible storage locations:

#### File Location

Partition stored as a local file:

```json
{ "type": "file", "filename": "00.cdb" }
```

#### HTTP Location

Partition accessible via HTTP(S):

```json
{ "type": "http", "url": "https://example.com/index/00.cdb" }
```

#### Arweave Transaction Location

Partition stored as an Arweave transaction:

```json
{ "type": "arweave-tx", "txId": "abc123..." }
```

#### Arweave Bundle Item Location

Partition stored as a data item within an Arweave bundle:

```json
{
  "type": "arweave-bundle-item",
  "txId": "abc123...",
  "offset": 1024,
  "size": 245760
}
```

## Partitioning Scheme

Records are partitioned based on the first byte of the 32-byte key:

- Key prefix `0x00` → `00.cdb`
- Key prefix `0x01` → `01.cdb`
- ...
- Key prefix `0xff` → `ff.cdb`

This provides uniform distribution for random keys (like transaction IDs).

## Lookup Algorithm

To look up a key in a partitioned index:

1. Read the first byte of the key to determine prefix
2. Find the partition with matching prefix in the manifest
3. If no partition exists for that prefix, key is not present
4. Open/read the partition CDB64 file
5. Look up the key using standard CDB64 lookup

## Reader Implementation

The partitioned reader (`PartitionedCdb64Reader`) features:

- **Lazy partition opening**: Partitions are only opened when first accessed
- **Graceful degradation**: Missing partition files return undefined rather than throwing
- **Multiple location types**: Supports file, HTTP, and Arweave sources
- **Caching for remote sources**: HTTP and Arweave partitions use byte-range caching

## Writer Implementation

The partitioned writer (`PartitionedCdb64Writer`) features:

- **Lazy partition creation**: Partition files are only created when records arrive
- **Atomic directory creation**: Writes to temp directory, then renames atomically
- **Automatic manifest generation**: Creates `manifest.json` with all partition metadata

## Usage Examples

### Creating a Partitioned Index

```typescript
import { PartitionedCdb64Writer } from './src/lib/partitioned-cdb64-writer.js';

const writer = new PartitionedCdb64Writer('/path/to/output-dir');
await writer.open();

for (const { key, value } of records) {
  await writer.add(key, value);  // Routes to partition based on key[0]
}

const manifest = await writer.finalize();
console.log(`Created ${manifest.partitions.length} partitions`);
```

### Reading from a Partitioned Index

```typescript
import { PartitionedCdb64Reader } from './src/lib/partitioned-cdb64-reader.js';
import { parseManifest } from './src/lib/cdb64-manifest.js';

const manifestJson = await fs.readFile('/path/to/index/manifest.json', 'utf-8');
const manifest = parseManifest(manifestJson);

const reader = new PartitionedCdb64Reader({
  manifest,
  baseDir: '/path/to/index',
});
await reader.open();

const value = await reader.get(keyBuffer);
await reader.close();
```

### CLI Tool Usage

```bash
# Create partitioned index from CSV
./tools/generate-cdb64-root-tx-index --input data.csv --partitioned --output-dir ./index/

# Create partitioned index from SQLite
./tools/export-sqlite-to-cdb64 --partitioned --output-dir ./index/
```

## Configuration

The gateway automatically detects partitioned indexes when a directory contains a `manifest.json` file:

```bash
# Configure with partitioned directory
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/partitioned-index/ yarn start

# Mix of single-file and partitioned sources
CDB64_ROOT_TX_INDEX_SOURCES=/path/to/single.cdb,/path/to/partitioned-index/ yarn start
```

## Backward Compatibility

- The gateway supports both single-file and partitioned CDB64 sources simultaneously
- When a directory contains `manifest.json`, it is treated as partitioned (ignoring loose `.cdb` files)
- When a directory contains no `manifest.json`, all `.cdb` files are loaded as individual indexes
- Single `.cdb` file paths continue to work unchanged
