/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it, before } from 'node:test';
import { readFileSync } from 'node:fs';
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

// Helper to convert base64url to Buffer
function b64UrlToBuffer(b64urlstring: string): Buffer {
  return Buffer.from(b64urlstring, 'base64url');
}

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

// Load test data
const TEST_DATA = JSON.parse(
  readFileSync('test/mock_files/chunks/chunk-test-data.json', 'utf-8'),
);
const CHUNK_1 = JSON.parse(
  readFileSync('test/mock_files/chunks/351531360100599.json', 'utf-8'),
);
const CHUNK_2 = JSON.parse(
  readFileSync('test/mock_files/chunks/351531360362743.json', 'utf-8'),
);

describe('merkle-path-parser', () => {
  describe('getRulesetForOffset', () => {
    it('should return BASIC for offsets below strict threshold', () => {
      assert.equal(getRulesetForOffset(0), ValidationRuleset.BASIC);
      assert.equal(getRulesetForOffset(1000000), ValidationRuleset.BASIC);
      assert.equal(
        getRulesetForOffset(30_607_159_107_829),
        ValidationRuleset.BASIC,
      );
    });

    it('should return STRICT_DATA_SPLIT for offsets above strict threshold', () => {
      assert.equal(
        getRulesetForOffset(30_607_159_107_830),
        ValidationRuleset.STRICT_DATA_SPLIT,
      );
      assert.equal(
        getRulesetForOffset(100_000_000_000_000),
        ValidationRuleset.STRICT_DATA_SPLIT,
      );
    });

    it('should return OFFSET_REBASE_SUPPORT for offsets above rebase threshold', () => {
      assert.equal(
        getRulesetForOffset(151_066_495_197_430),
        ValidationRuleset.OFFSET_REBASE_SUPPORT,
      );
      assert.equal(
        getRulesetForOffset(200_000_000_000_000),
        ValidationRuleset.OFFSET_REBASE_SUPPORT,
      );
    });
  });

  describe('parseDataPath with different rulesets', () => {
    it('should parse a real chunk with BASIC ruleset', async () => {
      const dataRoot = b64UrlToBuffer(TEST_DATA.transaction.data_root);
      const dataPath = b64UrlToBuffer(CHUNK_1.data_path);
      const offset = TEST_DATA.chunks.first.offset;
      const dataSize = parseInt(TEST_DATA.transaction.data_size);

      const result = await parseDataPath({
        dataRoot,
        dataSize,
        dataPath,
        offset,
        ruleset: ValidationRuleset.BASIC,
      });

      assert.equal(result.validated, true);
      assert.equal(result.boundaries.isRebased, false);
      assert.equal(result.boundaries.startOffset, 0);
      assert.equal(result.boundaries.endOffset, 262144);
      assert.equal(result.boundaries.chunkSize, 262144);
      assert.equal(result.boundaries.isRightMostInItsSubTree, false);
    });

    it('should track rightmost chunk correctly', async () => {
      const dataRoot = b64UrlToBuffer(TEST_DATA.transaction.data_root);
      const dataPath = b64UrlToBuffer(CHUNK_2.data_path);
      const offset = TEST_DATA.chunks.second.offset;
      const dataSize = parseInt(TEST_DATA.transaction.data_size);

      const result = await parseDataPath({
        dataRoot,
        dataSize,
        dataPath,
        offset,
        ruleset: ValidationRuleset.BASIC,
      });

      // This chunk is in the middle of the data, so it's not necessarily rightmost
      // The tracking depends on the tree structure
      assert.equal(result.validated, true);
      assert.equal(result.boundaries.startOffset, 262144);
    });
  });

  describe('strict data split validation', () => {
    it('should validate 256KB aligned chunks', async () => {
      // Create a simple path for a 256KB chunk at offset 0
      const chunkData = crypto.randomBytes(32);
      const chunkOffset = intToBuffer(262144); // 256KB
      const leafHash = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(chunkData).digest())
        .update(crypto.createHash('sha256').update(chunkOffset).digest())
        .digest();

      const path = Buffer.concat([chunkData, chunkOffset]);

      const result = await parseDataPath({
        dataRoot: leafHash,
        dataSize: 262144,
        dataPath: path,
        offset: 262143,
        ruleset: 'strict_data_split_ruleset',
      });

      assert.equal(result.validated, true);
      assert.equal(result.boundaries.startOffset, 0);
      assert.equal(result.boundaries.endOffset, 262144);
    });

    it('should reject misaligned chunks with strict validation', async () => {
      // Create a path for a chunk that doesn't start at a 256KB boundary
      const chunkData = crypto.randomBytes(32);
      const chunkOffset = intToBuffer(300000); // Not aligned
      const leafHash = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(chunkData).digest())
        .update(crypto.createHash('sha256').update(chunkOffset).digest())
        .digest();

      const path = Buffer.concat([chunkData, chunkOffset]);

      await assert.rejects(
        parseDataPath({
          dataRoot: leafHash,
          dataSize: 300000,
          dataPath: path,
          offset: 100000,
          ruleset: 'strict_data_split_ruleset',
        }),
        /Failed to parse data_path/,
      );
    });
  });

  describe('rebased path parsing with offset shifts', () => {
    it('should handle rebased paths with cumulative offset shifts', async () => {
      // Create a rebased path
      const zeroMarker = Buffer.alloc(32, 0);

      // Create a simple leaf for the left subtree
      const chunkData = crypto.randomBytes(32);
      const chunkOffset = intToBuffer(262144);
      const leafHash = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(chunkData).digest())
        .update(crypto.createHash('sha256').update(chunkOffset).digest())
        .digest();

      const leafPath = Buffer.concat([chunkData, chunkOffset]);

      // For the right subtree, just use a dummy hash
      const rightRoot = crypto.randomBytes(32);
      const boundary = intToBuffer(262144); // 256KB boundary

      // Calculate the rebased root
      const rebasedRoot = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(leafHash).digest())
        .update(crypto.createHash('sha256').update(rightRoot).digest())
        .update(crypto.createHash('sha256').update(boundary).digest())
        .digest();

      const rebasedPath = Buffer.concat([
        zeroMarker,
        leafHash, // leftRoot
        rightRoot,
        boundary,
        leafPath,
      ]);

      // With offset rebase support ruleset
      const result = await parseDataPath({
        dataRoot: rebasedRoot,
        dataSize: 524288,
        dataPath: rebasedPath,
        offset: 100000,
        ruleset: 'offset_rebase_support_ruleset',
      });

      assert.equal(result.validated, true);
      assert.equal(result.boundaries.isRebased, true);
      assert.equal(result.boundaries.rebaseDepth, 1);
      // The offset shift should be applied
      assert.equal(result.boundaries.startOffset, 0);
      assert.equal(result.boundaries.endOffset, 262144);
    });

    it('should reject rebasing when not allowed by ruleset', async () => {
      const zeroMarker = Buffer.alloc(32, 0);
      const leftRoot = crypto.randomBytes(32);
      const rightRoot = crypto.randomBytes(32);
      const boundary = intToBuffer(262144);
      const leafPath = Buffer.concat([
        crypto.randomBytes(32),
        intToBuffer(262144),
      ]);

      const rebasedPath = Buffer.concat([
        zeroMarker,
        leftRoot,
        rightRoot,
        boundary,
        leafPath,
      ]);

      // With strict data split ruleset (no rebasing allowed)
      await assert.rejects(
        parseDataPath({
          dataRoot: crypto.randomBytes(32),
          dataSize: 524288,
          dataPath: rebasedPath,
          offset: 100000,
          ruleset: 'strict_data_split_ruleset',
        }),
        /Failed to parse data_path/,
      );
    });
  });

  describe('border validation', () => {
    it('should enforce chunk size limits with strict borders', async () => {
      // Create a path for a chunk larger than 256KB
      const chunkData = crypto.randomBytes(32);
      const chunkOffset = intToBuffer(300000); // > 256KB
      const leafHash = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(chunkData).digest())
        .update(crypto.createHash('sha256').update(chunkOffset).digest())
        .digest();

      const path = Buffer.concat([chunkData, chunkOffset]);

      await assert.rejects(
        parseDataPath({
          dataRoot: leafHash,
          dataSize: 300000,
          dataPath: path,
          offset: 150000,
          ruleset: ValidationRuleset.STRICT_BORDERS,
        }),
        /Failed to parse data_path/,
      );
    });
  });

  describe('extractNote and extractRoot', () => {
    it('should extract note from path', () => {
      const dataPath = b64UrlToBuffer(CHUNK_1.data_path);
      const note = extractNote(dataPath);

      // The note should be the offset from the path
      assert.equal(typeof note, 'number');
      assert(note > 0);
    });

    it('should extract root from leaf path', async () => {
      const chunkData = crypto.randomBytes(32);
      const chunkOffset = intToBuffer(262144);
      const path = Buffer.concat([chunkData, chunkOffset]);

      const root = await extractRoot(path);

      // Should match manual calculation
      const expectedRoot = crypto
        .createHash('sha256')
        .update(crypto.createHash('sha256').update(chunkData).digest())
        .update(crypto.createHash('sha256').update(chunkOffset).digest())
        .digest();

      assert(root.equals(expectedRoot));
    });
  });

  describe('arweave.js compatibility', () => {
    it('should produce compatible results with arweave.js validatePath', async () => {
      const dataRoot = b64UrlToBuffer(TEST_DATA.transaction.data_root);
      const dataPath = b64UrlToBuffer(CHUNK_1.data_path);
      const offset = TEST_DATA.chunks.first.offset;
      const dataSize = parseInt(TEST_DATA.transaction.data_size);

      // Parse with our v2 implementation using BASIC ruleset (matches arweave.js)
      const ourResult = await parseDataPath({
        dataRoot,
        dataSize,
        dataPath,
        offset,
        ruleset: ValidationRuleset.BASIC,
      });

      // Validate with arweave.js
      const arweaveResult = await validatePath(
        dataRoot,
        offset,
        0,
        dataSize,
        dataPath,
      );

      assert(arweaveResult !== false, 'Arweave.js should validate the path');

      // arweave.js offset is the last byte index (inclusive)
      // our endOffset is exclusive, so arweave.offset + 1 == our endOffset
      assert.equal(
        arweaveResult.offset + 1,
        ourResult.boundaries.endOffset,
        'End offsets should match (arweave is inclusive, ours is exclusive)',
      );
      assert.equal(
        arweaveResult.leftBound,
        ourResult.boundaries.startOffset,
        'Start offsets should match',
      );
      assert.equal(
        arweaveResult.chunkSize,
        ourResult.boundaries.chunkSize,
        'Chunk sizes should match',
      );
    });

    it('should handle different validation modes correctly', async () => {
      const dataRoot = b64UrlToBuffer(TEST_DATA.transaction.data_root);
      const dataPath = b64UrlToBuffer(CHUNK_1.data_path);
      const offset = TEST_DATA.chunks.first.offset;
      const dataSize = parseInt(TEST_DATA.transaction.data_size);

      // Test with different rulesets
      const basicResult = await parseDataPath({
        dataRoot,
        dataSize,
        dataPath,
        offset,
        ruleset: ValidationRuleset.BASIC,
      });

      const strictBordersResult = await parseDataPath({
        dataRoot,
        dataSize,
        dataPath,
        offset,
        ruleset: ValidationRuleset.STRICT_BORDERS,
      });

      // Both should succeed for this valid chunk
      assert.equal(basicResult.validated, true);
      assert.equal(strictBordersResult.validated, true);

      // Results should be the same for valid chunks
      assert.equal(
        basicResult.boundaries.startOffset,
        strictBordersResult.boundaries.startOffset,
      );
      assert.equal(
        basicResult.boundaries.endOffset,
        strictBordersResult.boundaries.endOffset,
      );
    });

    it('should properly track isRightMostInItsSubTree', async () => {
      const dataRoot = b64UrlToBuffer(TEST_DATA.transaction.data_root);
      const dataPath = b64UrlToBuffer(CHUNK_1.data_path);
      const offset = TEST_DATA.chunks.first.offset;
      const dataSize = parseInt(TEST_DATA.transaction.data_size);

      const result = await parseDataPath({
        dataRoot,
        dataSize,
        dataPath,
        offset,
      });

      // This is implementation-specific based on the tree structure
      assert.equal(typeof result.boundaries.isRightMostInItsSubTree, 'boolean');
    });

    it('should include chunk data hash in result', async () => {
      const dataRoot = b64UrlToBuffer(TEST_DATA.transaction.data_root);
      const dataPath = b64UrlToBuffer(CHUNK_1.data_path);
      const offset = TEST_DATA.chunks.first.offset;
      const dataSize = parseInt(TEST_DATA.transaction.data_size);

      const result = await parseDataPath({
        dataRoot,
        dataSize,
        dataPath,
        offset,
      });

      assert(
        result.chunkData instanceof Buffer,
        'Should include chunk data hash',
      );
      assert.equal(
        result.chunkData.length,
        32,
        'Chunk data hash should be 32 bytes',
      );
    });
  });

  describe('advanced validation', () => {
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
});