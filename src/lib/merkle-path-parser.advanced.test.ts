/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import { parseDataPath, ValidationRuleset } from './merkle-path-parser.js';

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

// Helper to create a valid leaf node
async function createLeafNode(
  dataHash: Buffer,
  offset: number,
): Promise<{ hash: Buffer; path: Buffer }> {
  const offsetBuffer = intToBuffer(offset);
  const leafHash = await hash([await hash(dataHash), await hash(offsetBuffer)]);

  return {
    hash: leafHash,
    path: Buffer.concat([dataHash, offsetBuffer]),
  };
}

// Helper to create a valid branch node
async function createBranchNode(
  leftHash: Buffer,
  rightHash: Buffer,
  boundary: number,
): Promise<{ hash: Buffer; path: Buffer }> {
  const boundaryBuffer = intToBuffer(boundary);
  const branchHash = await hash([
    await hash(leftHash),
    await hash(rightHash),
    await hash(boundaryBuffer),
  ]);

  return {
    hash: branchHash,
    path: Buffer.concat([leftHash, rightHash, boundaryBuffer]),
  };
}

describe('merkle-path-parser advanced validation', () => {
  describe('strict data split edge cases', () => {
    it('should allow last chunk to span two buckets', async () => {
      // Create a scenario where the last chunk spans two 256KB buckets
      const dataSize = DATA_CHUNK_SIZE + 100000; // 356KB total

      // For a chunk spanning buckets, we need a proper tree structure
      // Chunk 1: 0-256KB
      const chunk1Data = crypto.randomBytes(32);
      const chunk1 = await createLeafNode(chunk1Data, DATA_CHUNK_SIZE);

      // Chunk 2: 256KB-356KB (last chunk, spans partial bucket)
      const chunk2Data = crypto.randomBytes(32);
      const chunk2 = await createLeafNode(chunk2Data, dataSize);

      // Create branch
      const branch = await createBranchNode(
        chunk1.hash,
        chunk2.hash,
        DATA_CHUNK_SIZE,
      );

      // Create path for the last chunk
      const path2 = Buffer.concat([
        chunk1.hash,
        chunk2.hash,
        intToBuffer(DATA_CHUNK_SIZE),
        chunk2.path,
      ]);

      const result = await parseDataPath({
        dataRoot: branch.hash,
        dataSize,
        dataPath: path2,
        offset: dataSize - 1, // Last byte
        ruleset: ValidationRuleset.STRICT_DATA_SPLIT,
      });

      // This should be allowed as it's the last chunk
      assert.equal(result.validated, true);
      assert.equal(result.boundaries.endOffset, dataSize);
      assert.equal(result.boundaries.startOffset, DATA_CHUNK_SIZE);
    });

    it('should allow second-last chunk under specific conditions', async () => {
      // Create scenario: data size between 256KB and 512KB
      const dataSize = DATA_CHUNK_SIZE + 50000; // 306KB

      // First chunk: 0-256KB
      const chunk1Data = crypto.randomBytes(32);
      const chunk1 = await createLeafNode(chunk1Data, DATA_CHUNK_SIZE);

      // Second chunk: 256KB-306KB (50KB, which is < 256KB)
      const chunk2Data = crypto.randomBytes(32);
      const chunk2 = await createLeafNode(chunk2Data, dataSize);

      // Create branch
      const branch = await createBranchNode(
        chunk1.hash,
        chunk2.hash,
        DATA_CHUNK_SIZE,
      );

      // Create path for first chunk
      const path1 = Buffer.concat([
        chunk1.hash,
        chunk2.hash,
        intToBuffer(DATA_CHUNK_SIZE),
        chunk1.path,
      ]);

      const result = await parseDataPath({
        dataRoot: branch.hash,
        dataSize,
        dataPath: path1,
        offset: DATA_CHUNK_SIZE - 1, // Last byte of first chunk
        ruleset: ValidationRuleset.STRICT_DATA_SPLIT,
      });

      // This should be allowed under the special second-last chunk rule
      assert.equal(result.validated, true);
      assert.equal(result.boundaries.startOffset, 0);
      assert.equal(result.boundaries.endOffset, DATA_CHUNK_SIZE);
    });

    it('should reject non-aligned chunks that dont meet exceptions', async () => {
      // Create a chunk that starts at non-aligned offset and isn't last/second-last
      const dataSize = DATA_CHUNK_SIZE * 3; // 768KB
      const chunkStartOffset = 100000; // Not aligned to 256KB
      const chunkEndOffset = chunkStartOffset + DATA_CHUNK_SIZE;

      const chunkData = crypto.randomBytes(32);
      const leaf = await createLeafNode(chunkData, chunkEndOffset);

      await assert.rejects(
        parseDataPath({
          dataRoot: leaf.hash,
          dataSize,
          dataPath: leaf.path,
          offset: chunkStartOffset + 1000,
          ruleset: ValidationRuleset.STRICT_DATA_SPLIT,
        }),
        /Failed to parse data_path/,
      );
    });
  });

  describe('relaxed split validation with rightmost tracking', () => {
    it('should validate rightmost chunks can span buckets', async () => {
      // Create a tree where we can control rightmost status
      const dataSize = DATA_CHUNK_SIZE * 2;

      // Create chunks
      const chunk1Data = crypto.randomBytes(32);
      const chunk1 = await createLeafNode(chunk1Data, DATA_CHUNK_SIZE);

      const chunk2Data = crypto.randomBytes(32);
      const chunk2 = await createLeafNode(chunk2Data, dataSize);

      // Create branch
      const branch = await createBranchNode(
        chunk1.hash,
        chunk2.hash,
        DATA_CHUNK_SIZE,
      );

      // Path for second chunk (rightmost)
      const path2 = Buffer.concat([
        chunk1.hash,
        chunk2.hash,
        intToBuffer(DATA_CHUNK_SIZE),
        chunk2.path,
      ]);

      const result = await parseDataPath({
        dataRoot: branch.hash,
        dataSize,
        dataPath: path2,
        offset: DATA_CHUNK_SIZE + 1000, // In second chunk
        ruleset: ValidationRuleset.OFFSET_REBASE_SUPPORT,
      });

      assert.equal(result.validated, true);
      assert.equal(result.boundaries.isRightMostInItsSubTree, true);
    });
  });

  describe('nested rebasing with cumulative shifts', () => {
    it('should handle multiple levels of rebasing with correct offsets', async () => {
      // Create a deeply nested rebased structure
      const zeroMarker = Buffer.alloc(32, 0);
      const chunkSize = DATA_CHUNK_SIZE;

      // Level 0: actual chunk
      const chunkData = crypto.randomBytes(32);
      const chunk = await createLeafNode(chunkData, chunkSize);

      // Level 1: first rebasing
      const rightRoot1 = crypto.randomBytes(32);
      const boundary1 = chunkSize;
      const rebasedRoot1 = await hash([
        await hash(chunk.hash),
        await hash(rightRoot1),
        await hash(intToBuffer(boundary1)),
      ]);

      const path1 = Buffer.concat([
        zeroMarker,
        chunk.hash,
        rightRoot1,
        intToBuffer(boundary1),
        chunk.path,
      ]);

      // Level 2: second rebasing
      const rightRoot2 = crypto.randomBytes(32);
      const boundary2 = chunkSize * 2;
      const rebasedRoot2 = await hash([
        await hash(rebasedRoot1),
        await hash(rightRoot2),
        await hash(intToBuffer(boundary2)),
      ]);

      const path2 = Buffer.concat([
        zeroMarker,
        rebasedRoot1,
        rightRoot2,
        intToBuffer(boundary2),
        path1,
      ]);

      // Parse with rebasing support
      const result = await parseDataPath({
        dataRoot: rebasedRoot2,
        dataSize: chunkSize * 4,
        dataPath: path2,
        offset: chunkSize / 2,
        ruleset: ValidationRuleset.OFFSET_REBASE_SUPPORT,
      });

      assert.equal(result.validated, true);
      assert.equal(result.boundaries.isRebased, true);
      assert.equal(result.boundaries.rebaseDepth, 2);
      assert.equal(result.boundaries.startOffset, 0);
      assert.equal(result.boundaries.endOffset, chunkSize);
    });
  });

  describe('border validation edge cases', () => {
    it('should enforce 256KB maximum chunk size with borders check', async () => {
      // Try to create a chunk larger than 256KB
      const chunkData = crypto.randomBytes(32);
      const oversizedOffset = DATA_CHUNK_SIZE + 1000;
      const leaf = await createLeafNode(chunkData, oversizedOffset);

      await assert.rejects(
        parseDataPath({
          dataRoot: leaf.hash,
          dataSize: oversizedOffset,
          dataPath: leaf.path,
          offset: DATA_CHUNK_SIZE + 500,
          ruleset: ValidationRuleset.STRICT_BORDERS,
        }),
        /Failed to parse data_path/,
      );
    });

    it('should allow exactly 256KB chunks with borders check', async () => {
      const chunkData = crypto.randomBytes(32);
      const leaf = await createLeafNode(chunkData, DATA_CHUNK_SIZE);

      const result = await parseDataPath({
        dataRoot: leaf.hash,
        dataSize: DATA_CHUNK_SIZE,
        dataPath: leaf.path,
        offset: DATA_CHUNK_SIZE - 1,
        ruleset: ValidationRuleset.STRICT_BORDERS,
      });

      assert.equal(result.validated, true);
      assert.equal(result.boundaries.chunkSize, DATA_CHUNK_SIZE);
    });
  });
});
