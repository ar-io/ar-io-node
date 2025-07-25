/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import crypto from 'node:crypto';

// Constants from Arweave merkle implementation
const HASH_SIZE = 32;
const NOTE_SIZE = 32;
const BRANCH_SIZE = HASH_SIZE * 2 + NOTE_SIZE; // 96 bytes
const LEAF_SIZE = HASH_SIZE + NOTE_SIZE; // 64 bytes
const DATA_CHUNK_SIZE = 256 * 1024; // 256KB

// Thresholds from Arweave consensus
const STRICT_DATA_SPLIT_THRESHOLD = 30_607_159_107_830;
const MERKLE_REBASE_SUPPORT_THRESHOLD = 151_066_495_197_430;

// Validation rulesets
export const ValidationRuleset = {
  BASIC: 'basic_ruleset',
  STRICT_BORDERS: 'strict_borders_ruleset',
  STRICT_DATA_SPLIT: 'strict_data_split_ruleset',
  OFFSET_REBASE_SUPPORT: 'offset_rebase_support_ruleset',
} as const;

export type ValidationRuleset =
  (typeof ValidationRuleset)[keyof typeof ValidationRuleset];

export interface ChunkBoundaries {
  startOffset: number; // Inclusive start byte in transaction
  endOffset: number; // Exclusive end byte in transaction
  chunkSize: number; // endOffset - startOffset
  isRebased: boolean; // Contains rebasing prefix
  rebaseDepth: number; // Number of rebasing levels
  isRightMostInItsSubTree: boolean; // Whether chunk is rightmost in its subtree
}

export interface ParsedDataPath {
  boundaries: ChunkBoundaries;
  proof: Buffer; // Normalized proof (rebasing processed)
  validated: boolean; // Cryptographically validated
  chunkData: Buffer; // The actual chunk data hash
}

interface ValidationContext {
  dataSize: number;
  isRightMostInItsSubTree: boolean | undefined;
  leftBoundShift: number;
  checkBorders: boolean;
  checkSplit: 'strict' | 'relaxed' | false;
  allowRebase: boolean;
  rebaseDepth: number;
}

/**
 * Determine which validation ruleset to use based on weave offset
 */
export function getRulesetForOffset(offset: number): ValidationRuleset {
  if (offset >= MERKLE_REBASE_SUPPORT_THRESHOLD) {
    return ValidationRuleset.OFFSET_REBASE_SUPPORT;
  } else if (offset >= STRICT_DATA_SPLIT_THRESHOLD) {
    return ValidationRuleset.STRICT_DATA_SPLIT;
  } else {
    return ValidationRuleset.BASIC;
  }
}

/**
 * Convert buffer to integer (big-endian)
 */
function bufferToInt(buffer: Buffer): number {
  let value = 0;
  for (let i = 0; i < buffer.length; i++) {
    value = value * 256 + buffer[i];
  }
  return value;
}

/**
 * Hash function matching Arweave's implementation
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
 * Compare two buffers for equality
 */
function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.compare(b) === 0;
}

/**
 * Validate chunk borders according to Arweave rules
 */
function validateBorders(
  endOffset: number,
  leftBound: number,
  rightBound: number,
  checkBorders: boolean,
): boolean {
  if (!checkBorders) {
    return true;
  }

  // Borders are only valid if every offset does not exceed the previous offset
  // by more than DATA_CHUNK_SIZE
  return (
    endOffset - leftBound <= DATA_CHUNK_SIZE &&
    rightBound - leftBound <= DATA_CHUNK_SIZE
  );
}

/**
 * Validate chunk split according to Arweave rules
 */
function validateSplit(
  endOffset: number,
  leftBound: number,
  rightBound: number,
  dataSize: number,
  checkSplit: 'strict' | 'relaxed' | false,
  isRightMostInItsSubTree: boolean | undefined,
  leftBoundShift: number,
): boolean {
  if (checkSplit === false) {
    return true;
  }

  const chunkSize = endOffset - leftBound;

  if (checkSplit === 'strict') {
    if (chunkSize === DATA_CHUNK_SIZE) {
      // Full chunks must start at chunk boundaries
      return leftBound % DATA_CHUNK_SIZE === 0;
    } else if (endOffset === dataSize) {
      // Last chunk may span two buckets
      const border = Math.floor(rightBound / DATA_CHUNK_SIZE) * DATA_CHUNK_SIZE;
      return rightBound % DATA_CHUNK_SIZE > 0 && leftBound <= border;
    } else {
      // Second-last chunk with special conditions
      return (
        leftBound % DATA_CHUNK_SIZE === 0 &&
        dataSize - leftBound > DATA_CHUNK_SIZE &&
        dataSize - leftBound < 2 * DATA_CHUNK_SIZE
      );
    }
  } else if (checkSplit === 'relaxed') {
    // Reject chunks smaller than 256 KiB unless they are the last or the only chunks
    // of their datasets or the second last chunks which do not exceed 256 KiB when
    // combined with the following (last) chunks.
    const shiftedLeftBound = leftBoundShift + leftBound;
    const shiftedEndOffset = leftBoundShift + endOffset;

    if (isRightMostInItsSubTree === true) {
      // The last chunk may either start at the bucket start or span two buckets
      const bucket0 = Math.floor(shiftedLeftBound / DATA_CHUNK_SIZE);
      const bucket1 = Math.floor(shiftedEndOffset / DATA_CHUNK_SIZE);

      return (
        shiftedLeftBound % DATA_CHUNK_SIZE === 0 ||
        (bucket0 + 1 === bucket1 && shiftedEndOffset % DATA_CHUNK_SIZE !== 0)
      );
    } else {
      // May also be the only chunk of a single-chunk subtree
      return shiftedLeftBound % DATA_CHUNK_SIZE === 0;
    }
  }

  return true;
}

/**
 * Walk the Merkle path to determine chunk boundaries
 */
async function walkMerklePath(params: {
  rootHash: Buffer;
  targetOffset: number;
  leftBound: number;
  rightBound: number;
  path: Buffer;
  context: ValidationContext;
}): Promise<ParsedDataPath | null> {
  const { rootHash, targetOffset, leftBound, rightBound, path, context } =
    params;

  // Validate inputs
  if (rightBound <= 0) {
    return null;
  }

  let currentLeftBound = leftBound;
  let currentRightBound = rightBound;
  let currentHash = rootHash;
  let pathOffset = 0;
  let isRightMostInItsSubTree = context.isRightMostInItsSubTree;

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

    // Calculate branch hash
    const branchOffset = bufferToInt(offsetBuffer);
    const calculatedHash = await hash([
      await hash(leftHash),
      await hash(rightHash),
      await hash(offsetBuffer),
    ]);

    if (!buffersEqual(calculatedHash, currentHash)) {
      return null;
    }

    // Determine which side contains our target
    if (targetOffset < branchOffset) {
      // Target is in left subtree
      currentHash = leftHash;
      currentRightBound = Math.min(currentRightBound, branchOffset);
      // We're going left, so we're not rightmost anymore
      isRightMostInItsSubTree = false;
    } else {
      // Target is in right subtree
      currentHash = rightHash;
      currentLeftBound = Math.max(currentLeftBound, branchOffset);
      // Keep rightmost status if we had it, otherwise set to true
      if (isRightMostInItsSubTree === undefined) {
        isRightMostInItsSubTree = true;
      }
    }
  }

  // Process leaf node
  if (pathOffset + LEAF_SIZE !== path.length) {
    // Invalid path length
    return null;
  }

  const leafDataHash = path.slice(pathOffset, pathOffset + HASH_SIZE);
  const leafOffsetBuffer = path.slice(
    pathOffset + HASH_SIZE,
    pathOffset + LEAF_SIZE,
  );
  const leafOffset = bufferToInt(leafOffsetBuffer);

  // Validate borders
  if (
    !validateBorders(
      leafOffset,
      currentLeftBound,
      currentRightBound,
      context.checkBorders,
    )
  ) {
    return null;
  }

  // Validate split
  if (
    !validateSplit(
      leafOffset,
      currentLeftBound,
      currentRightBound,
      context.dataSize,
      context.checkSplit,
      isRightMostInItsSubTree,
      context.leftBoundShift,
    )
  ) {
    return null;
  }

  // Validate leaf hash
  const expectedLeafHash = await hash([
    await hash(leafDataHash),
    await hash(leafOffsetBuffer),
  ]);

  if (!buffersEqual(expectedLeafHash, currentHash)) {
    return null;
  }

  // Calculate final boundaries with shift
  const startOffset = context.leftBoundShift + currentLeftBound;
  const endOffset =
    context.leftBoundShift +
    Math.max(Math.min(currentRightBound, leafOffset), currentLeftBound + 1);

  return {
    boundaries: {
      startOffset,
      endOffset,
      chunkSize: endOffset - startOffset,
      isRebased: context.rebaseDepth > 0,
      rebaseDepth: context.rebaseDepth,
      isRightMostInItsSubTree: isRightMostInItsSubTree || false,
    },
    proof: path,
    validated: true,
    chunkData: leafDataHash,
  };
}

/**
 * Parse rebasing prefix from a data_path
 */
async function parseRebasingPrefix(
  dataPath: Buffer,
  targetOffset: number,
  leftBound: number,
  rightBound: number,
  context: ValidationContext,
  rootHash?: Buffer,
): Promise<ParsedDataPath | null> {
  // Check if path starts with 32-byte zero marker
  if (dataPath.length < 128 || !context.allowRebase) {
    // Not a rebased path or rebasing not allowed
    if (!rootHash) {
      return null;
    }
    return walkMerklePath({
      rootHash,
      targetOffset,
      leftBound,
      rightBound,
      path: dataPath,
      context,
    });
  }

  const zeroMarker = dataPath.slice(0, 32);
  const isZeroMarker = zeroMarker.every((byte) => byte === 0);

  if (!isZeroMarker) {
    // No rebasing marker found
    if (!rootHash) {
      return null;
    }
    return walkMerklePath({
      rootHash,
      targetOffset,
      leftBound,
      rightBound,
      path: dataPath,
      context,
    });
  }

  // Extract rebasing components
  const leftRoot = dataPath.slice(32, 64);
  const rightRoot = dataPath.slice(64, 96);
  const boundary = dataPath.slice(96, 128);
  const remainingPath = dataPath.slice(128);

  const boundaryOffset = bufferToInt(boundary);

  // For rebased paths, we need to validate the hash if rootHash is provided
  if (rootHash) {
    const calculatedHash = await hash([
      await hash(leftRoot),
      await hash(rightRoot),
      await hash(boundary),
    ]);

    if (!buffersEqual(calculatedHash, rootHash)) {
      return null;
    }
  }

  // Determine which subtree to traverse
  let nextRootHash: Buffer;
  let nextLeftBound: number;
  let nextRightBound: number;
  let nextTargetOffset: number;
  let nextLeftBoundShift: number;

  if (targetOffset < boundaryOffset) {
    // Target is in left subtree
    const adjustedBoundary = Math.min(rightBound, boundaryOffset);
    nextRootHash = leftRoot;
    nextLeftBound = 0;
    nextRightBound = adjustedBoundary - leftBound;
    nextTargetOffset = targetOffset - leftBound;
    nextLeftBoundShift = context.leftBoundShift + leftBound;
  } else {
    // Target is in right subtree
    const adjustedBoundary = Math.max(leftBound, boundaryOffset);
    nextRootHash = rightRoot;
    nextLeftBound = 0;
    nextRightBound = rightBound - adjustedBoundary;
    nextTargetOffset = targetOffset - adjustedBoundary;
    nextLeftBoundShift = context.leftBoundShift + adjustedBoundary;
  }

  // Update context for next level
  const nextContext: ValidationContext = {
    ...context,
    leftBoundShift: nextLeftBoundShift,
    isRightMostInItsSubTree: undefined, // Reset for subtree
    rebaseDepth: context.rebaseDepth + 1,
  };

  // Recursively parse the remaining path
  return parseRebasingPrefix(
    remainingPath,
    nextTargetOffset,
    nextLeftBound,
    nextRightBound,
    nextContext,
    nextRootHash,
  );
}

/**
 * Parse a data_path to extract chunk boundaries with full Arweave validation
 */
export async function parseDataPath(params: {
  dataRoot: Buffer;
  dataSize: number;
  dataPath: Buffer;
  offset: number;
  ruleset?: ValidationRuleset;
}): Promise<ParsedDataPath> {
  const { dataRoot, dataSize, dataPath, offset } = params;

  // Determine ruleset if not provided
  const ruleset = params.ruleset ?? getRulesetForOffset(offset);

  // Set validation parameters based on ruleset
  let checkBorders = false;
  let checkSplit: 'strict' | 'relaxed' | false = false;
  let allowRebase = false;

  switch (ruleset) {
    case ValidationRuleset.BASIC:
      // No checks
      break;
    case ValidationRuleset.STRICT_BORDERS:
      checkBorders = true;
      break;
    case ValidationRuleset.STRICT_DATA_SPLIT:
      checkBorders = true;
      checkSplit = 'strict';
      break;
    case ValidationRuleset.OFFSET_REBASE_SUPPORT:
      checkBorders = true;
      checkSplit = 'relaxed';
      allowRebase = true;
      break;
  }

  // Clamp offset to valid range
  const clampedOffset = Math.max(0, Math.min(offset, dataSize - 1));

  // Initialize validation context
  const context: ValidationContext = {
    dataSize,
    isRightMostInItsSubTree: undefined,
    leftBoundShift: 0,
    checkBorders,
    checkSplit,
    allowRebase,
    rebaseDepth: 0,
  };

  // Parse the path - pass dataRoot for validation
  const result = await parseRebasingPrefix(
    dataPath,
    clampedOffset,
    0,
    dataSize,
    context,
    dataRoot,
  );

  if (!result) {
    throw new Error('Failed to parse data_path: invalid proof');
  }

  return result;
}

/**
 * Extract the note (offset) from a path - Arweave compatible
 */
export function extractNote(path: Buffer): number {
  if (path.length < NOTE_SIZE) {
    throw new Error('Path too short to contain note');
  }
  return bufferToInt(path.slice(path.length - NOTE_SIZE));
}

/**
 * Extract the Merkle root from a path - Arweave compatible
 */
export async function extractRoot(path: Buffer): Promise<Buffer> {
  if (path.length === LEAF_SIZE) {
    // Leaf node
    const data = path.slice(0, HASH_SIZE);
    const offset = path.slice(HASH_SIZE, LEAF_SIZE);
    return hash([await hash(data), await hash(offset)]);
  } else if (path.length >= BRANCH_SIZE) {
    // Branch node
    const left = path.slice(0, HASH_SIZE);
    const right = path.slice(HASH_SIZE, HASH_SIZE * 2);
    const note = path.slice(HASH_SIZE * 2, BRANCH_SIZE);
    return hash([await hash(left), await hash(right), await hash(note)]);
  } else {
    throw new Error('Invalid path length');
  }
}
