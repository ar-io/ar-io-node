# Arweave Transaction and Chunk Offsets

This document explains how Arweave's offset system works for transactions and
chunks, including the relationship between absolute offsets, relative offsets,
and chunk boundaries.

## Table of Contents

1. [Overview](#overview)
2. [Key Concepts](#key-concepts)
3. [Offset Types](#offset-types)
4. [Transaction Offsets](#transaction-offsets)
5. [Chunk Organization](#chunk-organization)
6. [Offset Calculations](#offset-calculations)
7. [Merkle Tree Structure](#merkle-tree-structure)
8. [Practical Examples](#practical-examples)
9. [Implementation Notes](#implementation-notes)

## Overview

Arweave uses an offset-based system to track the position of every byte of data
stored on the network.

## Key Concepts

### The Weave

The "weave" is the complete, append-only data structure containing all Arweave
transactions. Every byte in the weave has a unique position called an "absolute
offset".

### Absolute vs Relative Offsets

- **Absolute Offset**: The global position of a byte in the entire weave (0-indexed)
- **Relative Offset**: The position of a byte within a specific transaction (0-indexed)

### End-Offset Convention

Arweave uses end-offsets rather than start-offsets. A transaction's offset
represents the position of its last byte (inclusive) in the weave.

### Chunks

Transactions are divided into chunks for efficient storage and retrieval:

- Chunks are fixed-size pieces of transaction data (max 256 KiB each)
- Each chunk can be independently retrieved and verified
- Chunks enable partial data access without downloading entire transactions

## Offset Types

### 1. Transaction Offset

```
{
  "offset": "123456789", // Position of last byte (inclusive)
  "size": "1000"         // Transaction data size in bytes
}
```

### 2. Chunk Offset

- Represents the position of the last byte within a chunk
- Stored in the Merkle tree as part of the data_path

### 3. Absolute Chunk Offset

- The position of a chunk in the global weave
- Used to retrieve chunks from storage

### When Each Offset Type is Used

**Relative offsets** are used:

- Within data_path Merkle proofs (chunk positions within a transaction)
- When processing transaction data internally
- For calculating which chunk contains specific transaction bytes

**Absolute offsets** are used:

- When requesting chunks from Arweave nodes (`/chunk/{offset}`)
- For storing and retrieving chunks from disk
- In data sync operations between nodes

## Transaction Offsets

### Calculating Transaction Boundaries

Given a transaction offset response:

```javascript
const txOffset = {
  offset: 123456789, // Last byte position (inclusive)
  size: 1000, // Transaction size
};

// Calculate boundaries
const txEndOffset = txOffset.offset; // 123456789
const txStartOffset = txOffset.offset - txOffset.size + 1; // 123455790

// The transaction occupies bytes 123455790 through 123456789 (inclusive)
```

### Transaction Data Layout

```
Weave: [...previous data...][----Transaction Data----][...next data...]
                            ^                        ^
                            |                        |
                      txStartOffset             txEndOffset
                      (123455790)               (123456789)
```

## Chunk Organization

### Chunk Size Rules

- Maximum chunk size: 256 KiB (262,144 bytes)
- Last chunk of a transaction can be smaller than 256 KiB

### Chunk Boundaries in Transactions

For a transaction split into multiple chunks:

```
Transaction: [---Chunk 1---][---Chunk 2---][--Chunk 3--]
             ^             ^              ^            ^
             0          256KiB         512KiB       700KiB
             (relative offsets within transaction)
```

### Chunk Data Structure

When requesting chunks from Arweave, the response includes:

```typescript
{
  chunk: Buffer,     // The actual chunk data (up to 256KiB)
  tx_path: Buffer,   // Merkle path proving chunk belongs to block (variable size)
  data_path: Buffer, // Merkle path proving chunk position in transaction (variable size)
  packing: string,   // Packing type (e.g., "unpacked", "spora_2_5", "spora_2_6")
}
```

Additional fields in chunk proofs:

- `chunk_start_offset`: Start position of chunk within transaction
- `chunk_end_offset`: End position of chunk within transaction
- `tx_start_offset`: Start position of transaction in weave
- `tx_end_offset`: End position of transaction in weave
- `block_start_offset`: Start position of block in weave
- `block_end_offset`: End position of block in weave

### Transaction Order vs Offset Order

Transactions in a block appear in **inclusion order** (the order they were added to the block), but their offsets are assigned based on **ID sort order**.

Before assigning offsets, Arweave sorts all transactions in a block by their transaction ID (compared as binary data). This means:

- A transaction's position in a block does not indicate its offset range
- The first transaction in a block may have a larger offset than the last transaction
- To determine offset order, transactions must be sorted by their ID as binary data

For example, in a block with transactions at indices 0 and 1:
- The transaction at index 0 might have offset range 345449326488888-345449326492026
- The transaction at index 1 might have offset range 345449328058615-345449412246841
- This happens because the transaction at index 1 has an ID that sorts before the transaction at index 0

## Offset Calculations

### Converting Between Offset Types

#### Relative to Absolute

```javascript
function relativeToAbsolute(relativeOffset, txStartOffset) {
  return txStartOffset + relativeOffset;
}
```

#### Absolute to Relative

```javascript
function absoluteToRelative(absoluteOffset, txStartOffset) {
  return absoluteOffset - txStartOffset;
}
```

### Finding Chunk Containing an Offset

To find which chunk contains a specific byte:

1. **Using Relative Offset** (within transaction):

   ```javascript
   const chunkIndex = Math.floor(relativeOffset / 256_144);
   const offsetInChunk = relativeOffset % 256_144;
   ```

2. **Using Absolute Offset**:
   ```javascript
   // First convert to relative
   const relativeOffset = absoluteOffset - txStartOffset;
   // Then find chunk as above
   ```

### Chunk Boundary Extraction

The Merkle path parser extracts exact chunk boundaries from the data_path:

```javascript
// Parsed from data_path
{
  startOffset: 256144,    // Start of chunk within transaction (inclusive)
  endOffset: 512288,      // End of chunk within transaction (exclusive)
  chunkSize: 256144,      // Actual size of this chunk
}

// Combined with transaction offset to get absolute positions:
{
  absoluteStart: txStartOffset + startOffset,
  absoluteEnd: txStartOffset + endOffset
}
```

## Merkle Tree Structure

### Offset Storage in Merkle Trees

Each node in the Merkle tree stores an offset representing the cumulative size
up to that point:

```
                    Root (700KiB)
                   /            \
            Node (512KiB)      Leaf3 (700KiB)
           /          \
    Leaf1 (256KiB)  Leaf2 (512KiB)
```

### Data Path Structure

The data_path contains the Merkle proof with embedded offsets:

```
Standard path (single chunk):
[chunk_hash (32 bytes)][chunk_offset (32 bytes)]

Multi-chunk path (each level adds 96 bytes):
[left_hash (32 bytes)][right_hash (32 bytes)][boundary_offset (32 bytes)]...[chunk_hash (32 bytes)][chunk_offset (32 bytes)]
```

## Practical Examples

### Example 1: Serving a Range Request

Request: Bytes 300,000-400,000 of a transaction

Note: The request uses relative offsets (within the transaction), but chunk
retrieval requires absolute offsets.

```javascript
// Step 1: Get transaction offset (from Arweave node)
// GET /tx/{txId}/offset
const txOffsetResponse = await fetch(`/tx/${txId}/offset`);
const txOffset = await txOffsetResponse.json();
// Returns: { offset: "123456789", size: "1048576" }

// Step 2: Calculate absolute positions
const txEndOffset = parseInt(txOffset.offset);
const txSize = parseInt(txOffset.size);
const txStartOffset = txEndOffset - txSize + 1;

// Step 3: Convert requested range to absolute offsets
const rangeStartAbs = txStartOffset + 300000; // 123455790 + 300000
const rangeEndAbs = txStartOffset + 400000; // 123455790 + 400000

// Step 4: Request chunks at these absolute offsets
// GET /chunk/123755790
// GET /chunk/123855790 (if range spans multiple chunks)
```

### Example 2: Chunk Resolution

Arweave's `/chunk/{offset}` endpoint requires an absolute offset (position in the weave):

```javascript
// Request chunk at absolute offset 123755790
// GET /chunk/123755790
// Node returns:
{
  chunk: <Buffer...>,      // The chunk data (up to 256KiB)
  tx_path: <Buffer...>,    // Proof of inclusion in block (variable size)
  data_path: <Buffer...>,  // Proof of position in transaction (variable size)
  packing: "spora_2_6"     // Packing format used
}

// The data_path can be parsed to extract chunk boundaries:
// - Chunk spans bytes 262144-524288 within the transaction
// - Combined with tx offset: absolute bytes 123717934-123980078
```

### Example 3: Multi-Range Request

For a video player requesting multiple ranges:

```javascript
// Assume we've already fetched the transaction offset
const txEndOffset = 123456789;
const txSize = 1048576;
const txStartOffset = txEndOffset - txSize + 1;

// Multiple ranges requested by client
const ranges = [
  { start: 0, end: 1024 }, // Header/metadata
  { start: 500000, end: 600000 }, // Seek position
];

// Convert each range to absolute offsets
for (const range of ranges) {
  const absStart = txStartOffset + range.start;
  const absEnd = txStartOffset + range.end;

  // Note: You cannot calculate chunk boundaries directly from offsets
  // unless the transaction uses strict data splitting.
  // Instead, request chunks by any offset within the desired range:

  // GET /chunk/{absStart} - returns chunk containing this offset
  // Parse the returned data_path to determine actual chunk boundaries
  // Request additional chunks if range spans multiple chunks
}
```

## Implementation Notes

### Efficiency Considerations

1. **Direct Chunk Access**: Using absolute offsets allows O(1) chunk lookup
2. **Minimal Data Transfer**: Only fetch chunks containing requested bytes
3. **Streaming Support**: Process chunks as they arrive without buffering all

### Edge Cases

1. **Single-Byte Ranges**: Supported by seeking to exact chunk
2. **Chunk Boundaries**: Ranges spanning multiple chunks handled sequentially
3. **Last Chunk**: May be smaller than 256KiB, requires special handling

### Validation

Always validate:

- Offset calculations don't exceed transaction boundaries
- Chunk boundaries align with expected sizes
- Merkle proofs validate against data_root

## Related Documentation

- [Arweave Yellow Paper](https://www.arweave.org/yellow-paper.pdf) - Section on data structure
- [ANS-104 Specification](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md) - Bundle offset handling
- Merkle Path Parser Implementation - `src/lib/merkle-path-parser.ts`
