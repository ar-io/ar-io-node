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

Values are MessagePack-encoded objects with short keys for compactness:

### Simple Format

Used when only the root transaction ID is known:

```javascript
{
  r: <Buffer 32 bytes>  // Root transaction ID (binary)
}
```

### Complete Format

Used when offset information is available:

```javascript
{
  r: <Buffer 32 bytes>,  // Root transaction ID (binary)
  i: <integer>,          // Root data item offset (byte offset of data item header)
  d: <integer>           // Root data offset (byte offset of data payload)
}
```

### Field Mapping

| MessagePack Key | Full Name | Description |
|-----------------|-----------|-------------|
| `r` | rootTxId | 32-byte root transaction ID |
| `i` | rootDataItemOffset | Byte offset of nested data item within root TX |
| `d` | rootDataOffset | Byte offset of data payload within root TX |

These offsets correspond to the HTTP headers:
- `i` → `X-AR-IO-Root-Data-Item-Offset`
- `d` → `X-AR-IO-Root-Data-Offset`

## Example

For a data item `abc123...` nested in root TX `xyz789...` at offset 1024 with data at offset 1536:

**Key** (32 bytes):
```
6abc123... (raw binary data item ID)
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
