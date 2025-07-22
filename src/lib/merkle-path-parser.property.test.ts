/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import crypto from 'node:crypto';
import { validatePath } from 'arweave/node/lib/merkle.js';
import {
  parseDataPath,
  ValidationRuleset,
  getRulesetForOffset,
  extractNote,
  extractRoot,
} from './merkle-path-parser.js';

const DATA_CHUNK_SIZE = 256 * 1024;

// Helper to convert integer to 32-byte buffer (big-endian)
function intToBuffer(value: number): Buffer {
  const buffer = Buffer.alloc(32);
  let remaining = value;
  for (let i = 31; i >= 0 && remaining > 0; i--) {
    buffer[i] = remaining & 0xff;
    remaining = remaining >>> 8;
  }
  return buffer;
}

// Helper to create a hash
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

// Create a valid single-chunk tree
async function createSingleChunkTree(
  chunkSize: number,
): Promise<{ root: Buffer; path: Buffer; dataHash: Buffer }> {
  const dataHash = crypto.randomBytes(32);
  const offsetBuffer = intToBuffer(chunkSize);

  const root = await hash([await hash(dataHash), await hash(offsetBuffer)]);

  const path = Buffer.concat([dataHash, offsetBuffer]);

  return { root, path, dataHash };
}

// Create a valid two-chunk tree
async function createTwoChunkTree(
  chunk1Size: number,
  chunk2Size: number,
): Promise<{
  root: Buffer;
  path1: Buffer;
  path2: Buffer;
  dataHash1: Buffer;
  dataHash2: Buffer;
}> {
  const dataHash1 = crypto.randomBytes(32);
  const dataHash2 = crypto.randomBytes(32);

  const leaf1Hash = await hash([
    await hash(dataHash1),
    await hash(intToBuffer(chunk1Size)),
  ]);

  const leaf2Hash = await hash([
    await hash(dataHash2),
    await hash(intToBuffer(chunk1Size + chunk2Size)),
  ]);

  const boundary = intToBuffer(chunk1Size);
  const root = await hash([
    await hash(leaf1Hash),
    await hash(leaf2Hash),
    await hash(boundary),
  ]);

  const path1 = Buffer.concat([
    leaf1Hash,
    leaf2Hash,
    boundary,
    dataHash1,
    intToBuffer(chunk1Size),
  ]);

  const path2 = Buffer.concat([
    leaf1Hash,
    leaf2Hash,
    boundary,
    dataHash2,
    intToBuffer(chunk1Size + chunk2Size),
  ]);

  return { root, path1, path2, dataHash1, dataHash2 };
}

describe('merkle-path-parser property tests', () => {
  it('should validate single chunk trees with various sizes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: DATA_CHUNK_SIZE }),
        async (chunkSize) => {
          const { root, path } = await createSingleChunkTree(chunkSize);
          const targetOffset = Math.floor(Math.random() * chunkSize);

          const result = await parseDataPath({
            dataRoot: root,
            dataSize: chunkSize,
            dataPath: path,
            offset: targetOffset,
            ruleset: ValidationRuleset.BASIC,
          });

          assert(result.validated);
          assert.equal(result.boundaries.startOffset, 0);
          assert.equal(result.boundaries.endOffset, chunkSize);
          assert.equal(result.boundaries.chunkSize, chunkSize);
          assert(!result.boundaries.isRebased);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should validate two-chunk trees with proper boundaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: DATA_CHUNK_SIZE }),
        fc.integer({ min: 1, max: DATA_CHUNK_SIZE }),
        async (chunk1Size, chunk2Size) => {
          const { root, path1, path2 } = await createTwoChunkTree(
            chunk1Size,
            chunk2Size,
          );
          const totalSize = chunk1Size + chunk2Size;

          // Test first chunk
          const offset1 = Math.floor(Math.random() * chunk1Size);
          const result1 = await parseDataPath({
            dataRoot: root,
            dataSize: totalSize,
            dataPath: path1,
            offset: offset1,
            ruleset: ValidationRuleset.BASIC,
          });

          assert(result1.validated);
          assert.equal(result1.boundaries.startOffset, 0);
          assert.equal(result1.boundaries.endOffset, chunk1Size);
          assert(!result1.boundaries.isRightMostInItsSubTree);

          // Test second chunk
          const offset2 = chunk1Size + Math.floor(Math.random() * chunk2Size);
          const result2 = await parseDataPath({
            dataRoot: root,
            dataSize: totalSize,
            dataPath: path2,
            offset: offset2,
            ruleset: ValidationRuleset.BASIC,
          });

          assert(result2.validated);
          assert.equal(result2.boundaries.startOffset, chunk1Size);
          assert.equal(result2.boundaries.endOffset, totalSize);
          assert(result2.boundaries.isRightMostInItsSubTree);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should enforce strict data split rules correctly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10 }), // Number of full chunks
        fc.integer({ min: 1, max: DATA_CHUNK_SIZE - 1 }), // Remainder size
        async (numFullChunks, remainder) => {
          const totalSize = numFullChunks * DATA_CHUNK_SIZE + remainder;

          // Create a properly aligned chunk
          const { root, path } = await createSingleChunkTree(DATA_CHUNK_SIZE);
          const offset = DATA_CHUNK_SIZE / 2;

          const result = await parseDataPath({
            dataRoot: root,
            dataSize: DATA_CHUNK_SIZE,
            dataPath: path,
            offset,
            ruleset: ValidationRuleset.STRICT_DATA_SPLIT,
          });

          assert(result.validated);
          assert.equal(result.boundaries.startOffset, 0);
          assert.equal(result.boundaries.endOffset, DATA_CHUNK_SIZE);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('should reject oversized chunks with strict borders', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: DATA_CHUNK_SIZE + 1, max: DATA_CHUNK_SIZE + 100000 }),
        async (oversizedChunk) => {
          const { root, path } = await createSingleChunkTree(oversizedChunk);
          const offset = DATA_CHUNK_SIZE / 2;

          await assert.rejects(
            parseDataPath({
              dataRoot: root,
              dataSize: oversizedChunk,
              dataPath: path,
              offset,
              ruleset: ValidationRuleset.STRICT_BORDERS,
            }),
            /Failed to parse data_path/,
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it('should handle rebased paths with zero marker', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1024, max: DATA_CHUNK_SIZE }),
        async (chunkSize) => {
          const { root, path, dataHash } =
            await createSingleChunkTree(chunkSize);

          // Create rebased path
          const rightRoot = crypto.randomBytes(32);
          const boundary = intToBuffer(chunkSize);
          const rebasedRoot = await hash([
            await hash(root),
            await hash(rightRoot),
            await hash(boundary),
          ]);

          const rebasedPath = Buffer.concat([
            Buffer.alloc(32, 0), // Zero marker
            root,
            rightRoot,
            boundary,
            path,
          ]);

          const offset = Math.floor(Math.random() * chunkSize);
          const result = await parseDataPath({
            dataRoot: rebasedRoot,
            dataSize: chunkSize * 2, // Larger data size for rebased context
            dataPath: rebasedPath,
            offset,
            ruleset: ValidationRuleset.OFFSET_REBASE_SUPPORT,
          });

          assert(result.validated);
          assert(result.boundaries.isRebased);
          assert.equal(result.boundaries.rebaseDepth, 1);
          assert.equal(result.boundaries.startOffset, 0);
          assert.equal(result.boundaries.endOffset, chunkSize);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('should correctly determine rulesets for different offsets', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 300_000_000_000_000 }),
        (offset) => {
          const ruleset = getRulesetForOffset(offset);

          if (offset >= 151_066_495_197_430) {
            assert.equal(ruleset, ValidationRuleset.OFFSET_REBASE_SUPPORT);
          } else if (offset >= 30_607_159_107_830) {
            assert.equal(ruleset, ValidationRuleset.STRICT_DATA_SPLIT);
          } else {
            assert.equal(ruleset, ValidationRuleset.BASIC);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('should extract notes correctly from any path', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 32 - 1 }), // Limit to 32-bit values for accuracy
        fc.integer({ min: 0, max: 10 }), // Extra branch nodes
        (expectedNote, extraNodes) => {
          // Build path with note at the end
          let path = Buffer.concat([
            crypto.randomBytes(32), // data hash
            intToBuffer(expectedNote),
          ]);

          // Add branch nodes
          for (let i = 0; i < extraNodes; i++) {
            path = Buffer.concat([
              crypto.randomBytes(32), // left
              crypto.randomBytes(32), // right
              crypto.randomBytes(32), // boundary
              path,
            ]);
          }

          const extractedNote = extractNote(path);
          assert.equal(extractedNote, expectedNote);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('should handle edge cases in offset clamping', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 100000 }),
        fc.integer({ min: -1000, max: 200000 }),
        async (dataSize, requestedOffset) => {
          const { root, path } = await createSingleChunkTree(dataSize);

          const result = await parseDataPath({
            dataRoot: root,
            dataSize,
            dataPath: path,
            offset: requestedOffset,
            ruleset: ValidationRuleset.BASIC,
          });

          assert(result.validated);

          // Verify offset was clamped correctly
          const clampedOffset = Math.max(
            0,
            Math.min(requestedOffset, dataSize - 1),
          );
          assert(clampedOffset >= result.boundaries.startOffset);
          assert(clampedOffset < result.boundaries.endOffset);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should preserve cryptographic properties', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1024, max: DATA_CHUNK_SIZE }),
        async (chunkSize) => {
          const { root, path, dataHash } =
            await createSingleChunkTree(chunkSize);

          const result = await parseDataPath({
            dataRoot: root,
            dataSize: chunkSize,
            dataPath: path,
            offset: chunkSize / 2,
            ruleset: ValidationRuleset.BASIC,
          });

          assert(result.validated);

          // Verify chunk data hash matches
          assert(result.chunkData.equals(dataHash));

          // Verify root extraction
          const extractedRoot = await extractRoot(path);
          assert(extractedRoot.equals(root));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should maintain consistency across different rulesets for valid data', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: DATA_CHUNK_SIZE, max: DATA_CHUNK_SIZE }), // Exactly 256KB
        async (chunkSize) => {
          const { root, path } = await createSingleChunkTree(chunkSize);
          const offset = chunkSize / 2;

          // Test with different rulesets - all should pass for aligned chunk
          const rulesets = [
            ValidationRuleset.BASIC,
            ValidationRuleset.STRICT_BORDERS,
            ValidationRuleset.STRICT_DATA_SPLIT,
            ValidationRuleset.OFFSET_REBASE_SUPPORT,
          ];

          for (const ruleset of rulesets) {
            const result = await parseDataPath({
              dataRoot: root,
              dataSize: chunkSize,
              dataPath: path,
              offset,
              ruleset,
            });

            assert(result.validated, `Failed for ruleset ${ruleset}`);
            assert.equal(result.boundaries.startOffset, 0);
            assert.equal(result.boundaries.endOffset, chunkSize);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('should validate generated paths with arweave.js for compatibility', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: DATA_CHUNK_SIZE }),
        fc.integer({ min: 0, max: 1 }), // 0 for single chunk, 1 for two chunks
        async (chunkSize, useDoubleChunk) => {
          if (useDoubleChunk === 0) {
            // Test single chunk paths
            const { root, path } = await createSingleChunkTree(chunkSize);
            const offset = Math.floor(Math.random() * chunkSize);

            // Validate with our implementation
            const ourResult = await parseDataPath({
              dataRoot: root,
              dataSize: chunkSize,
              dataPath: path,
              offset,
              ruleset: ValidationRuleset.BASIC,
            });

            // Validate with arweave.js
            const arweaveResult = await validatePath(
              root,
              offset,
              0,
              chunkSize,
              path,
            );

            assert(
              ourResult.validated,
              'Our parser should validate the generated path',
            );
            assert(
              arweaveResult !== false,
              'Arweave.js should validate the generated path',
            );

            // Compare results (arweave.js offset is inclusive, ours is exclusive)
            assert.equal(
              arweaveResult.offset + 1,
              ourResult.boundaries.endOffset,
              'End offsets should match',
            );
            assert.equal(
              arweaveResult.leftBound,
              ourResult.boundaries.startOffset,
              'Start offsets should match',
            );
          } else {
            // Test two chunk paths
            const chunk1Size = Math.floor(Math.random() * DATA_CHUNK_SIZE) + 1;
            const chunk2Size = Math.floor(Math.random() * DATA_CHUNK_SIZE) + 1;
            const { root, path1, path2 } = await createTwoChunkTree(
              chunk1Size,
              chunk2Size,
            );
            const totalSize = chunk1Size + chunk2Size;

            // Test first chunk
            const offset1 = Math.floor(Math.random() * chunk1Size);
            const ourResult1 = await parseDataPath({
              dataRoot: root,
              dataSize: totalSize,
              dataPath: path1,
              offset: offset1,
              ruleset: ValidationRuleset.BASIC,
            });

            const arweaveResult1 = await validatePath(
              root,
              offset1,
              0,
              totalSize,
              path1,
            );

            assert(ourResult1.validated, 'Our parser should validate chunk 1');
            assert(
              arweaveResult1 !== false,
              'Arweave.js should validate chunk 1',
            );
            assert.equal(
              arweaveResult1.offset + 1,
              ourResult1.boundaries.endOffset,
            );
            assert.equal(
              arweaveResult1.leftBound,
              ourResult1.boundaries.startOffset,
            );

            // Test second chunk
            const offset2 = chunk1Size + Math.floor(Math.random() * chunk2Size);
            const ourResult2 = await parseDataPath({
              dataRoot: root,
              dataSize: totalSize,
              dataPath: path2,
              offset: offset2,
              ruleset: ValidationRuleset.BASIC,
            });

            const arweaveResult2 = await validatePath(
              root,
              offset2,
              0,
              totalSize,
              path2,
            );

            assert(ourResult2.validated, 'Our parser should validate chunk 2');
            assert(
              arweaveResult2 !== false,
              'Arweave.js should validate chunk 2',
            );
            assert.equal(
              arweaveResult2.offset + 1,
              ourResult2.boundaries.endOffset,
            );
            assert.equal(
              arweaveResult2.leftBound,
              ourResult2.boundaries.startOffset,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
