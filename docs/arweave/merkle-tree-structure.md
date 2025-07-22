# Arweave Merkle Tree Structure and Data Paths

This document provides a detailed explanation of Arweave's Merkle tree structure, including how data_path and data_root work together, and how rebasing affects the tree structure.

## Table of Contents

1. [Merkle Tree Fundamentals](#merkle-tree-fundamentals)
2. [Node Types and Hashing](#node-types-and-hashing)
3. [Data Path Structure](#data-path-structure)
4. [Data Root](#data-root)
5. [Path Validation Algorithm](#path-validation-algorithm)
6. [Rebasing Mechanism](#rebasing-mechanism)
7. [Examples](#examples)
8. [Implementation Considerations](#implementation-considerations)

## Merkle Tree Fundamentals

### Purpose
Arweave uses Merkle trees to:
- Prove that a chunk belongs to a specific transaction
- Determine the exact position of a chunk within a transaction
- Enable efficient verification without downloading the entire transaction

### Tree Construction Rules
1. Binary tree structure (each non-leaf has exactly 2 children)
2. Leaves correspond to transaction chunks (max 256KB each)
3. Each node contains hash and offset information
4. Tree is built bottom-up from chunks

### Visual Representation
```
4-chunk transaction (768KB total):
[--Chunk0--][--Chunk1--][--Chunk2--][--Chunk3--]
   256KB      256KB      256KB       0KB (empty)

Merkle Tree:
                     Root
                   /      \
              Branch1      Branch2
             /      \     /      \
         Leaf0   Leaf1  Leaf2   Leaf3
```

## Node Types and Hashing

### Leaf Nodes
Leaf nodes represent actual data chunks:

```javascript
// First, the chunk data is hashed once and stored in the data_path
chunk_hash = SHA256(chunk_data)

// Then, the leaf hash is calculated by hashing the components
leaf_hash = SHA256(
  SHA256(chunk_hash) || 
  SHA256(chunk_end_offset_bytes)
)
```

Components:
- `chunk_data`: The actual bytes of the chunk (up to 256KB)
- `chunk_hash`: SHA256 hash of the chunk data (stored in data_path)
- `chunk_end_offset_bytes`: 32-byte big-endian representation of where this chunk ends

### Branch Nodes
Branch nodes combine two child nodes:

```javascript
// Branch hash calculation
branch_hash = SHA256(
  SHA256(left_child_hash) || 
  SHA256(right_child_hash) || 
  SHA256(boundary_offset_bytes)
)
```

Components:
- `left_child_hash`: Hash of the left subtree
- `right_child_hash`: Hash of the right subtree
- `boundary_offset_bytes`: 32-byte offset where left subtree ends

### Hashing Pattern
Arweave's hashing pattern for Merkle trees:
1. **Raw data hashing**: Chunk data is hashed once to produce `chunk_hash`
2. **Component hashing**: Each component (hashes and offsets) is hashed individually before concatenation
3. **Final hashing**: The concatenated hashes are hashed to produce the node hash

This pattern ensures that:
- Chunk data is efficiently hashed only once
- All tree components are uniformly processed
- The structure is cryptographically secure

## Data Path Structure

### Purpose
A data_path is a Merkle proof that:
1. Proves a chunk belongs to a transaction
2. Provides the chunk's exact position
3. Allows reconstruction of the root hash

### Path Encoding
The path is encoded from bottom (leaf) to top (root):

```
Standard path structure (for a 3-level tree):

[Level 1 - Sibling info]
Bytes 0-31:    left_sibling_hash
Bytes 32-63:   right_sibling_hash  
Bytes 64-95:   parent_boundary_offset

[Level 2 - Parent's sibling info]
Bytes 96-127:  left_uncle_hash
Bytes 128-159: right_uncle_hash
Bytes 160-191: grandparent_boundary_offset

[Leaf data]
Bytes 192-223: chunk_data_hash
Bytes 224-255: chunk_end_offset
```

### Path Length Formula
```
path_length = 32 + (tree_height * 96)
```
Where tree_height = ceil(log2(number_of_chunks))

## Data Root

### Definition
The data_root is the SHA256 hash of the Merkle tree's root node. It's stored in the transaction header and serves as the verification target.

### Calculation
For a root with two children:
```javascript
data_root = SHA256(
  SHA256(left_subtree_root) ||
  SHA256(right_subtree_root) ||
  SHA256(total_data_size)
)
```

### Usage
```javascript
// In transaction header
{
  "id": "transaction_id",
  "data_root": "base64url_encoded_root_hash",
  "data_size": "1048576",
  // ... other fields
}
```

## Path Validation Algorithm

### Bottom-Up Validation
```javascript
function validatePath(chunk_data, data_path, expected_root, chunk_offset) {
  // 1. Verify chunk data matches path
  const chunk_hash = SHA256(chunk_data);
  const path_chunk_hash = data_path.slice(-64, -32);
  assert(chunk_hash.equals(path_chunk_hash));
  
  // 2. Reconstruct leaf hash
  const offset_bytes = data_path.slice(-32);
  let current_hash = SHA256(
    SHA256(chunk_data) || 
    SHA256(offset_bytes)
  );
  
  // 3. Walk up the tree
  let position = chunk_offset;
  for (let i = 0; i < tree_height; i++) {
    const level_data = extractLevel(data_path, i);
    const { left, right, boundary } = level_data;
    
    // Determine if we're left or right child
    if (position <= boundary) {
      current_hash = SHA256(
        SHA256(current_hash) ||
        SHA256(right) ||
        SHA256(boundary)
      );
    } else {
      current_hash = SHA256(
        SHA256(left) ||
        SHA256(current_hash) ||
        SHA256(boundary)
      );
    }
  }
  
  // 4. Verify we reached the expected root
  return current_hash.equals(expected_root);
}
```

## Rebasing Mechanism

### What is Rebasing?
Rebasing is a mechanism introduced in Arweave 2.7 to handle:
1. Combining multiple Merkle trees efficiently
2. Creating bundles of transactions (ANS-104)
3. Nested data structures

### Rebased Path Structure
A rebased path has a special prefix:

```
[Rebase Marker and Metadata]
Bytes 0-31:    32 zero bytes (marker)
Bytes 32-63:   left_root_hash
Bytes 64-95:   right_root_hash
Bytes 96-127:  boundary_offset

[Regular path continues...]
Bytes 128+:    Standard path structure
```

### How Rebasing Works

#### Scenario: Combining Two Trees
```
Original trees:
Tree A (512KB)          Tree B (256KB)
     RootA                  RootB
    /     \                /     \
  ...      ...           ...     ...

Combined tree with rebasing:
         NewRoot (768KB)
        /               \
    RootA (512KB)    RootB (768KB)*
                           ↑
                    *offset adjusted by 512KB
```

#### Offset Adjustment
When a chunk is in the right subtree of a rebased tree:
```javascript
adjusted_offset = original_offset + left_tree_size;
```

### Nested Rebasing
Rebasing can be nested multiple levels deep:

```
[First rebase marker - 128 bytes]
[Second rebase marker - 128 bytes]  
[Third rebase marker - 128 bytes]
[Regular path data]
```

Each level adjusts offsets based on its boundary.

## Examples

### Example 1: Simple 2-Chunk Transaction

```javascript
// Transaction: 300KB total
// Chunk 1: 256KB, Chunk 2: 44KB

// Merkle tree:
//       Root (300KB)
//      /            \
// Leaf1 (256KB)  Leaf2 (300KB)

// Data path for Chunk 2:
const chunk2_path = Buffer.concat([
  SHA256(chunk1_data),        // 32 bytes - sibling hash
  SHA256(chunk2_data),        // 32 bytes - this chunk hash  
  encode256KB,                // 32 bytes - boundary offset
  SHA256(chunk2_data),        // 32 bytes - chunk data hash
  encode300KB                 // 32 bytes - chunk end offset
]);

// Data root calculation:
const data_root = SHA256(
  SHA256(leaf1_hash) ||
  SHA256(leaf2_hash) ||
  SHA256(encode300KB)
);
```

### Example 2: Rebased Bundle

```javascript
// Two transactions bundled together
// TX1: 200KB, TX2: 150KB

// Original roots:
const tx1_root = "..."; // Root of TX1's Merkle tree
const tx2_root = "..."; // Root of TX2's Merkle tree

// Bundle root with rebasing:
const bundle_root = SHA256(
  SHA256(tx1_root) ||
  SHA256(tx2_root) ||
  SHA256(encode200KB)  // Boundary at 200KB
);

// Path for chunk in TX2 includes rebase prefix:
const rebased_path = Buffer.concat([
  Buffer.alloc(32),    // Zero marker
  tx1_root,            // 32 bytes
  tx2_root,            // 32 bytes
  encode200KB,         // 32 bytes - boundary
  original_tx2_path    // Original path within TX2
]);
```

### Example 3: Validating a Rebased Path

```javascript
function validateRebasedPath(chunk_data, data_path, expected_root) {
  let path = data_path;
  let offset_adjustment = 0;
  
  // Process rebase markers
  while (isZeroMarker(path.slice(0, 32))) {
    const left_root = path.slice(32, 64);
    const right_root = path.slice(64, 96);
    const boundary = decodeBigEndian(path.slice(96, 128));
    
    // If chunk is in right subtree, adjust offset
    if (chunk_offset > boundary) {
      offset_adjustment += boundary;
    }
    
    path = path.slice(128); // Continue with remaining path
  }
  
  // Validate regular path with adjusted offset
  return validatePath(
    chunk_data, 
    path, 
    expected_root, 
    chunk_offset + offset_adjustment
  );
}
```

## Implementation Considerations

### Validation Rules
Different validation rules apply based on block height:
1. **Basic**: Simple hash validation
2. **Strict Borders**: Enforce chunk size limits
3. **Strict Data Split**: Additional constraints on tree structure
4. **Offset Rebase Support**: Allow rebased paths (height > 1,190,000)

### Performance Optimizations
1. **Cache Parsed Paths**: Parsing is expensive, cache results
2. **Batch Validation**: Validate multiple chunks together
3. **Early Termination**: Stop on first validation failure

### Security Considerations
1. **Always Validate**: Never trust provided offsets without validation
2. **Check Boundaries**: Ensure offsets don't exceed transaction size
3. **Verify Hashes**: All hash computations must match exactly

### Common Pitfalls
1. **Endianness**: All offsets are big-endian encoded
2. **Zero Padding**: 32-byte values must be properly padded
3. **Hash Order**: Hash each component individually before concatenation
4. **Offset Interpretation**: Offsets represent end positions, not start
5. **Chunk Hash Storage**: The chunk hash in data_path is SHA256(chunk_data), not the raw data

## Related Documentation

- [Transaction and Chunk Offsets](./transaction-and-chunk-offsets.md)
- [Arweave Yellow Paper](https://www.arweave.org/yellow-paper.pdf)
- [ANS-104 Bundle Specification](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md)