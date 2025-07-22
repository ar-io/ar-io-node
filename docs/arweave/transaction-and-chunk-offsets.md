# Arweave Transaction and Chunk Offsets

This document explains how Arweave's offset system works for transactions and chunks, including the relationship between absolute offsets, relative offsets, and chunk boundaries.

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

Arweave uses an offset-based system to track the position of every byte of data stored on the network. This system enables efficient data retrieval by allowing nodes to locate any specific byte without scanning through all previous data.

## Key Concepts

### The Weave
The "weave" is the complete, append-only data structure containing all Arweave transactions. Every byte in the weave has a unique position called an "absolute offset".

### Absolute vs Relative Offsets
- **Absolute Offset**: The global position of a byte in the entire weave (0-indexed)
- **Relative Offset**: The position of a byte within a specific transaction (0-indexed)

### End-Offset Convention
Arweave uses end-offsets rather than start-offsets. A transaction's offset represents the position of its last byte (inclusive) in the weave.

## Offset Types

### 1. Transaction Offset
```
{
  "offset": "123456789",  // Position of last byte (inclusive)
  "size": "1000"         // Transaction data size in bytes
}
```

### 2. Chunk Offset
- Represents the position of the last byte within a chunk
- Stored in the Merkle tree as part of the data_path

### 3. Absolute Chunk Offset
- The position of a chunk in the global weave
- Used to retrieve chunks from storage

## Transaction Offsets

### Calculating Transaction Boundaries

Given a transaction offset response:
```javascript
const txOffset = {
  offset: 123456789,  // Last byte position (inclusive)
  size: 1000         // Transaction size
};

// Calculate boundaries
const txEndOffset = txOffset.offset;                    // 123456789
const txStartOffset = txOffset.offset - txOffset.size + 1;  // 123455790

// The transaction occupies bytes 123455790 through 123456789 (inclusive)
```

### Transaction Data Layout

```
Weave: [...previous data...][----Transaction Data----][...next data...]
                            ^                         ^
                            |                         |
                      txStartOffset              txEndOffset
                      (123455790)                (123456789)
```

## Chunk Organization

### Chunk Size Rules
- Maximum chunk size: 256 KB (262,144 bytes)
- Last chunk of a transaction can be smaller
- Chunks are created during the proof-of-access process

### Chunk Boundaries in Transactions

For a transaction split into multiple chunks:
```
Transaction: [---Chunk 1---][---Chunk 2---][--Chunk 3--]
             ^             ^              ^             ^
             0           256KB         512KB         700KB
             (relative offsets within transaction)
```

### Chunk Data Structure
```javascript
{
  chunk: Buffer,           // The actual chunk data
  data_path: Buffer,       // Merkle proof including offsets
  data_root: Buffer,       // Root hash of the Merkle tree
  data_size: number,       // Total transaction size
  offset: number,          // Relative offset within transaction
  hash: Buffer            // SHA-256 hash of chunk data
}
```

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

The Merkle path parser extracts exact chunk boundaries:
```javascript
// From parsed data_path
{
  startOffset: 256144,    // Start of chunk (inclusive)
  endOffset: 512288,      // End of chunk (exclusive)
  chunkSize: 256144,      // Actual size of this chunk
  absoluteOffset: 123711934  // Position in weave
}
```

## Merkle Tree Structure

### Offset Storage in Merkle Trees

Each node in the Merkle tree stores an offset representing the cumulative size up to that point:

```
                    Root (700KB)
                   /            \
            Node (512KB)      Leaf3 (700KB)
           /          \
    Leaf1 (256KB)  Leaf2 (512KB)
```

### Data Path Structure

The data_path contains the Merkle proof with embedded offsets:
```
Standard path (single chunk):
[chunk_hash (32 bytes)][chunk_offset (32 bytes)]

Multi-chunk path:
[left_hash][right_hash][boundary_offset]...[chunk_hash][chunk_offset]
```

## Practical Examples

### Example 1: Serving a Range Request

Request: Bytes 300,000-400,000 of a transaction

```javascript
// Given transaction info
const txOffset = { offset: 123456789, size: 1048576 }; // 1MB transaction
const txStart = txOffset.offset - txOffset.size + 1;   // 123455790

// Convert range to absolute offsets
const rangeStartAbs = txStart + 300000;  // 123755790
const rangeEndAbs = txStart + 400000;    // 123855790

// Determine chunks needed
// Chunk 2: bytes 256KB-512KB (contains start of range)
// Need bytes 300000-400000, which spans into chunk 2
```

### Example 2: Chunk Resolution

Arweave nodes can resolve any absolute offset to its containing chunk:

```javascript
// Request chunk at absolute offset 123755790
// Node returns chunk containing that offset with its boundaries
{
  chunk: <Buffer...>,
  boundaries: {
    startOffset: 262144,  // Relative start in transaction
    endOffset: 524288,    // Relative end in transaction
    absoluteStart: 123717934,
    absoluteEnd: 123980078
  }
}
```

### Example 3: Multi-Range Request

For a video player requesting multiple ranges:
```javascript
const ranges = [
  { start: 0, end: 1024 },        // Header
  { start: 500000, end: 600000 }  // Seek position
];

// Process each range independently
for (const range of ranges) {
  const absStart = txStart + range.start;
  const absEnd = txStart + range.end;
  // Fetch only chunks containing these ranges
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
3. **Last Chunk**: May be smaller than 256KB, requires special handling

### Validation

Always validate:
- Offset calculations don't exceed transaction boundaries
- Chunk boundaries align with expected sizes
- Merkle proofs validate against data_root

## Related Documentation

- [Arweave Yellow Paper](https://www.arweave.org/yellow-paper.pdf) - Section on data structure
- [ANS-104 Specification](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md) - Bundle offset handling
- Merkle Path Parser Implementation - `src/lib/merkle-path-parser.ts`