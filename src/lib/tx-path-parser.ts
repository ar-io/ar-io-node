/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import crypto from 'node:crypto';

import { fromB64Url } from './encoding.js';

// Constants from Arweave merkle implementation (same as merkle-path-parser.ts)
const HASH_SIZE = 32;
const NOTE_SIZE = 32;
const BRANCH_SIZE = HASH_SIZE * 2 + NOTE_SIZE; // 96 bytes
const LEAF_SIZE = HASH_SIZE + NOTE_SIZE; // 64 bytes

/**
 * Result of parsing a tx_path Merkle proof.
 *
 * Note: Offset fields use bigint to avoid precision loss for large weave offsets
 * that may exceed Number.MAX_SAFE_INTEGER (~9 petabytes).
 */
export interface ParsedTxPath {
  /** Transaction's data_root extracted from the leaf node */
  dataRoot: Buffer;
  /** Transaction end offset in weave (from leaf) */
  txEndOffset: bigint;
  /** Transaction start offset (calculated from path traversal) */
  txStartOffset: bigint;
  /** Transaction size (txEndOffset - txStartOffset) */
  txSize: bigint;
  /** Position in sorted TX list (for TX ID lookup) */
  txIndex: number;
  /** Whether the path was cryptographically validated against tx_root */
  validated: boolean;
}

/**
 * Context for tracking index bounds during Merkle tree traversal.
 */
interface TxPathValidationContext {
  txCount: number;
  leftIndex: number;
  rightIndex: number;
  leftBound: bigint; // Absolute weave offset (start of block data)
  rightBound: bigint; // Absolute weave offset (end of block data)
}

/**
 * Convert buffer to BigInt (big-endian).
 * Uses BigInt to avoid precision loss for large offsets (> Number.MAX_SAFE_INTEGER).
 */
function bufferToBigInt(buffer: Buffer): bigint {
  let value = BigInt(0);
  for (let i = 0; i < buffer.length; i++) {
    value = value * BigInt(256) + BigInt(buffer[i]);
  }
  return value;
}

/**
 * BigInt-aware minimum function.
 */
function bigIntMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * BigInt-aware maximum function.
 */
function bigIntMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Safely convert BigInt to number, throwing if value exceeds safe integer range.
 *
 * @param value - The bigint value to convert
 * @param fieldName - Name of the field (for error messages)
 * @returns The value as a number
 * @throws Error if value exceeds Number.MAX_SAFE_INTEGER or Number.MIN_SAFE_INTEGER
 */
export function safeBigIntToNumber(value: bigint, fieldName: string): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new Error(
      `${fieldName} exceeds safe integer range: ${value.toString()}`,
    );
  }
  return Number(value);
}

/**
 * Hash function matching Arweave's implementation.
 * Same implementation as merkle-path-parser.ts.
 */
async function hash(data: Buffer | Buffer[]): Promise<Buffer> {
  const hasher = crypto.createHash('sha256');
  if (Array.isArray(data)) {
    for (const chunk of data) {
      hasher.update(chunk);
    }
  } else {
    hasher.update(data);
  }
  return hasher.digest();
}

/**
 * Compare two buffers for equality.
 * Same implementation as merkle-path-parser.ts.
 */
function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.compare(b) === 0;
}

/**
 * Walk the TX Merkle path to determine transaction boundaries and index.
 *
 * Unlike data_path, tx_path walks from tx_root to find:
 * - Transaction boundaries (start/end offset in weave)
 * - Transaction index (position in sorted TX list)
 * - Data root (from leaf node)
 *
 * The TX Merkle tree is built from transactions sorted by binary ID.
 * We track index bounds during traversal to determine the final TX index.
 */
async function walkTxMerklePath(params: {
  rootHash: Buffer;
  targetOffset: bigint;
  path: Buffer;
  context: TxPathValidationContext;
}): Promise<ParsedTxPath | null> {
  const { rootHash, targetOffset, path, context } = params;

  // Validate inputs
  if (context.rightBound <= BigInt(0)) {
    return null;
  }

  let currentLeftBound = context.leftBound;
  let currentRightBound = context.rightBound;
  let currentHash = rootHash;
  let pathOffset = 0;

  // Track index range during traversal
  let leftIndex = context.leftIndex;
  let rightIndex = context.rightIndex;

  // Process branch nodes
  while (path.length - pathOffset > LEAF_SIZE) {
    if (pathOffset + BRANCH_SIZE > path.length) {
      // Invalid path length
      return null;
    }

    // Extract branch components
    const leftHash = path.slice(pathOffset, pathOffset + HASH_SIZE);
    const rightHash = path.slice(
      pathOffset + HASH_SIZE,
      pathOffset + HASH_SIZE * 2,
    );
    const offsetBuffer = path.slice(
      pathOffset + HASH_SIZE * 2,
      pathOffset + BRANCH_SIZE,
    );
    pathOffset += BRANCH_SIZE;

    // Calculate branch hash and validate
    const branchOffset = bufferToBigInt(offsetBuffer);
    const calculatedHash = await hash([
      await hash(leftHash),
      await hash(rightHash),
      await hash(offsetBuffer),
    ]);

    if (!buffersEqual(calculatedHash, currentHash)) {
      // Hash mismatch - invalid proof
      return null;
    }

    // Calculate midpoint index for TX selection
    const midIndex = Math.floor((leftIndex + rightIndex) / 2);

    // Determine which side contains our target (BigInt comparison)
    if (targetOffset < branchOffset) {
      // Target is in left subtree
      currentHash = leftHash;
      currentRightBound = bigIntMin(currentRightBound, branchOffset);
      rightIndex = midIndex;
    } else {
      // Target is in right subtree
      currentHash = rightHash;
      currentLeftBound = bigIntMax(currentLeftBound, branchOffset);
      leftIndex = midIndex + 1;
    }
  }

  // Process leaf node
  if (pathOffset + LEAF_SIZE !== path.length) {
    // Invalid path length
    return null;
  }

  const leafDataRoot = path.slice(pathOffset, pathOffset + HASH_SIZE);
  const leafOffsetBuffer = path.slice(
    pathOffset + HASH_SIZE,
    pathOffset + LEAF_SIZE,
  );
  const leafOffset = bufferToBigInt(leafOffsetBuffer);

  // Validate leaf hash
  const expectedLeafHash = await hash([
    await hash(leafDataRoot),
    await hash(leafOffsetBuffer),
  ]);

  if (!buffersEqual(expectedLeafHash, currentHash)) {
    // Leaf hash mismatch
    return null;
  }

  // Final index should be narrowed to single TX
  if (leftIndex !== rightIndex) {
    // Index not resolved - this can happen with inconsistent tree
    return null;
  }

  return {
    dataRoot: leafDataRoot,
    txEndOffset: leafOffset,
    txStartOffset: currentLeftBound,
    txSize: leafOffset - currentLeftBound,
    txIndex: leftIndex,
    validated: true,
  };
}

/**
 * Parses an Arweave tx_path to extract transaction boundaries and validate
 * the proof against the block's tx_root.
 *
 * The tx_path is a Merkle proof that proves a transaction's position within
 * a block. By validating this proof against the block's tx_root, we can
 * cryptographically verify transaction boundaries without doing an expensive
 * binary search through the block's transactions.
 *
 * @param params - Parsing parameters
 * @param params.txRoot - The block's transaction Merkle root
 * @param params.txPath - The Merkle proof path to parse
 * @param params.targetOffset - The absolute weave offset being requested (bigint for precision)
 * @param params.blockWeaveSize - Current block's weave_size (bigint for precision)
 * @param params.prevBlockWeaveSize - Previous block's weave_size (bigint for precision)
 * @param params.txCount - Number of transactions in the block
 *
 * @returns Parsed tx_path with boundaries and TX index, or null on validation failure
 *
 * @remarks
 * The returned `ParsedTxPath` contains:
 * - `dataRoot` - Transaction's data merkle root (32 bytes)
 * - `txEndOffset` - Absolute weave offset where transaction data ends (bigint)
 * - `txStartOffset` - Absolute weave offset where transaction data starts (bigint)
 * - `txSize` - Size of transaction data in bytes (bigint)
 * - `txIndex` - Index in sorted (by binary ID) transaction list
 * - `validated` - Whether the proof was cryptographically verified
 *
 * The `txIndex` can be used to look up the transaction ID from a sorted
 * list of block transactions (sorted by binary representation of TX ID).
 *
 * Returns `null` on any validation failure, which should trigger a fallback
 * to the traditional binary search approach.
 *
 * @example
 * ```typescript
 * const parsed = await parseTxPath({
 *   txRoot: block.tx_root,
 *   txPath: chunk.tx_path,
 *   targetOffset: BigInt(absoluteOffset),
 *   blockWeaveSize: BigInt(block.weave_size),
 *   prevBlockWeaveSize: BigInt(prevBlock.weave_size),
 *   txCount: block.txs.length,
 * });
 *
 * if (parsed) {
 *   const sortedTxs = sortTxIdsByBinary(block.txs);
 *   const txId = sortedTxs[parsed.txIndex];
 *   console.log(`Transaction ${txId}: bytes ${parsed.txStartOffset}-${parsed.txEndOffset}`);
 * }
 * ```
 */
export async function parseTxPath(params: {
  txRoot: Buffer;
  txPath: Buffer;
  targetOffset: bigint;
  blockWeaveSize: bigint;
  prevBlockWeaveSize: bigint;
  txCount: number;
}): Promise<ParsedTxPath | null> {
  const {
    txRoot,
    txPath,
    targetOffset,
    blockWeaveSize,
    prevBlockWeaveSize,
    txCount,
  } = params;

  // Validate input: empty blocks have no transactions
  if (txCount === 0) {
    return null;
  }

  // Validate path structure
  if (txPath.length < LEAF_SIZE) {
    return null;
  }

  // Path must be leaf (64 bytes) + N branches (96 bytes each)
  if ((txPath.length - LEAF_SIZE) % BRANCH_SIZE !== 0) {
    return null;
  }

  // Initialize context with block boundaries and full TX range
  const context: TxPathValidationContext = {
    txCount,
    leftIndex: 0,
    rightIndex: txCount - 1,
    leftBound: prevBlockWeaveSize,
    rightBound: blockWeaveSize,
  };

  return walkTxMerklePath({
    rootHash: txRoot,
    targetOffset,
    path: txPath,
    context,
  });
}

/**
 * Sort transaction IDs by their binary representation.
 *
 * This matches Arweave's Merkle tree ordering for transactions.
 * Transactions are sorted by their base64url-decoded binary representation
 * using lexicographic comparison.
 *
 * Note: This assumes all transactions are format-2 (post fork 2.0, April 2020).
 * For mixed format-1/format-2 blocks, the actual Merkle tree order may differ
 * because Arweave sorts by full TX record tuple, which sorts by format first.
 * The dataRoot validation step will catch these mismatches.
 *
 * @param txIds - Array of base64url-encoded transaction IDs
 * @returns New array sorted by binary representation
 *
 * @example
 * ```typescript
 * const sortedTxIds = sortTxIdsByBinary(block.txs);
 * const txId = sortedTxIds[parsed.txIndex];
 * ```
 */
export function sortTxIdsByBinary(txIds: string[]): string[] {
  return [...txIds].sort((a, b) => {
    const bufA = fromB64Url(a);
    const bufB = fromB64Url(b);
    return Buffer.compare(bufA, bufB);
  });
}

/**
 * Extract the data_root from a tx_path leaf node.
 *
 * The leaf is the last 64 bytes of the path:
 * - data_root (32 bytes)
 * - tx_end_offset (32 bytes)
 *
 * This is a convenience function for cases where you need the data_root
 * without full path validation.
 *
 * @param txPath - The tx_path buffer
 * @returns The data_root buffer (32 bytes)
 * @throws Error if txPath is too short
 */
export function extractDataRootFromTxPath(txPath: Buffer): Buffer {
  if (txPath.length < LEAF_SIZE) {
    throw new Error('tx_path too short to contain leaf node');
  }
  // Leaf is at the end, data_root is first 32 bytes of leaf
  return txPath.slice(txPath.length - LEAF_SIZE, txPath.length - NOTE_SIZE);
}

/**
 * Extract the tx_end_offset from a tx_path leaf node.
 *
 * @param txPath - The tx_path buffer
 * @returns The tx_end_offset as a bigint (for precision with large offsets)
 * @throws Error if txPath is too short
 */
export function extractTxEndOffsetFromTxPath(txPath: Buffer): bigint {
  if (txPath.length < LEAF_SIZE) {
    throw new Error('tx_path too short to contain leaf node');
  }
  return bufferToBigInt(txPath.slice(txPath.length - NOTE_SIZE));
}
