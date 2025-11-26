/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';
import {
  parseTxPath,
  safeBigIntToNumber,
  sortTxIdsByBinary,
  extractDataRootFromTxPath,
  extractTxEndOffsetFromTxPath,
} from './tx-path-parser.js';
import { toB64Url } from './encoding.js';

// Helper to convert bigint to 32-byte buffer (big-endian)
function bigIntToBuffer(value: bigint): Buffer {
  const buffer = Buffer.alloc(32);
  let remaining = value;
  for (let i = 31; i >= 0 && remaining > BigInt(0); i--) {
    buffer[i] = Number(remaining & BigInt(0xff));
    remaining = remaining >> BigInt(8);
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

// Create a valid TX leaf node (dataRoot + txEndOffset)
async function createTxLeafNode(
  dataRoot: Buffer,
  txEndOffset: bigint,
): Promise<{ hash: Buffer; path: Buffer }> {
  const offsetBuffer = bigIntToBuffer(txEndOffset);
  const leafHash = await hash([await hash(dataRoot), await hash(offsetBuffer)]);
  return {
    hash: leafHash,
    path: Buffer.concat([dataRoot, offsetBuffer]),
  };
}

// Create a valid TX branch node
async function createTxBranchNode(
  leftHash: Buffer,
  rightHash: Buffer,
  boundary: bigint,
): Promise<{ hash: Buffer; path: Buffer }> {
  const boundaryBuffer = bigIntToBuffer(boundary);
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

describe('tx-path-parser', () => {
  describe('parseTxPath', () => {
    it('should parse a single-TX block path (leaf only)', async () => {
      const dataRoot = crypto.randomBytes(32);
      const prevBlockWeaveSize = BigInt(1000000);
      const blockWeaveSize = BigInt(1100000);
      const txEndOffset = blockWeaveSize;

      const leaf = await createTxLeafNode(dataRoot, txEndOffset);

      const result = await parseTxPath({
        txRoot: leaf.hash,
        txPath: leaf.path,
        targetOffset: BigInt(1050000), // Within the TX range
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 1,
      });

      assert(result !== null, 'Result should not be null');
      assert.equal(result.validated, true);
      assert.equal(result.txIndex, 0);
      assert.equal(result.txEndOffset, txEndOffset);
      assert.equal(result.txStartOffset, prevBlockWeaveSize);
      assert.equal(result.txSize, txEndOffset - prevBlockWeaveSize);
      assert(result.dataRoot.equals(dataRoot));
    });

    it('should track index correctly in two-TX block (left subtree)', async () => {
      // Create two transactions
      const dataRoot1 = crypto.randomBytes(32);
      const dataRoot2 = crypto.randomBytes(32);
      const prevBlockWeaveSize = BigInt(1000000);
      const tx1EndOffset = BigInt(1050000); // TX 1 ends here
      const tx2EndOffset = BigInt(1100000); // TX 2 ends here
      const blockWeaveSize = tx2EndOffset;

      // Build the tree: branch -> [leaf1, leaf2]
      const leaf1 = await createTxLeafNode(dataRoot1, tx1EndOffset);
      const leaf2 = await createTxLeafNode(dataRoot2, tx2EndOffset);
      const branch = await createTxBranchNode(
        leaf1.hash,
        leaf2.hash,
        tx1EndOffset, // Boundary at TX 1's end offset
      );

      // Path for TX 1 (left subtree): branch + leaf1
      const path1 = Buffer.concat([branch.path, leaf1.path]);
      const result1 = await parseTxPath({
        txRoot: branch.hash,
        txPath: path1,
        targetOffset: BigInt(1025000), // Within TX 1
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 2,
      });

      assert(result1 !== null, 'Result1 should not be null');
      assert.equal(result1.txIndex, 0, 'TX 1 should have index 0');
      assert.equal(result1.txEndOffset, tx1EndOffset);
      assert.equal(result1.txStartOffset, prevBlockWeaveSize);
      assert(result1.dataRoot.equals(dataRoot1));
    });

    it('should track index correctly in two-TX block (right subtree)', async () => {
      const dataRoot1 = crypto.randomBytes(32);
      const dataRoot2 = crypto.randomBytes(32);
      const prevBlockWeaveSize = BigInt(1000000);
      const tx1EndOffset = BigInt(1050000);
      const tx2EndOffset = BigInt(1100000);
      const blockWeaveSize = tx2EndOffset;

      const leaf1 = await createTxLeafNode(dataRoot1, tx1EndOffset);
      const leaf2 = await createTxLeafNode(dataRoot2, tx2EndOffset);
      const branch = await createTxBranchNode(
        leaf1.hash,
        leaf2.hash,
        tx1EndOffset,
      );

      // Path for TX 2 (right subtree): branch + leaf2
      const path2 = Buffer.concat([branch.path, leaf2.path]);
      const result2 = await parseTxPath({
        txRoot: branch.hash,
        txPath: path2,
        targetOffset: BigInt(1075000), // Within TX 2
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 2,
      });

      assert(result2 !== null, 'Result2 should not be null');
      assert.equal(result2.txIndex, 1, 'TX 2 should have index 1');
      assert.equal(result2.txEndOffset, tx2EndOffset);
      assert.equal(result2.txStartOffset, tx1EndOffset);
      assert(result2.dataRoot.equals(dataRoot2));
    });

    it('should track index correctly in four-TX block', async () => {
      // Build a balanced tree with 4 transactions
      const dataRoots = [
        crypto.randomBytes(32),
        crypto.randomBytes(32),
        crypto.randomBytes(32),
        crypto.randomBytes(32),
      ];
      const prevBlockWeaveSize = BigInt(1000000);
      const offsets = [
        BigInt(1025000),
        BigInt(1050000),
        BigInt(1075000),
        BigInt(1100000),
      ];
      const blockWeaveSize = offsets[3];

      // Create leaves
      const leaves = await Promise.all(
        dataRoots.map((dr, i) => createTxLeafNode(dr, offsets[i])),
      );

      // Create level 1 branches (left: tx0+tx1, right: tx2+tx3)
      const leftBranch = await createTxBranchNode(
        leaves[0].hash,
        leaves[1].hash,
        offsets[0], // Boundary between tx0 and tx1
      );
      const rightBranch = await createTxBranchNode(
        leaves[2].hash,
        leaves[3].hash,
        offsets[2], // Boundary between tx2 and tx3
      );

      // Create root branch
      const root = await createTxBranchNode(
        leftBranch.hash,
        rightBranch.hash,
        offsets[1], // Boundary between left and right subtrees
      );

      // Test TX 0 (leftmost)
      const path0 = Buffer.concat([root.path, leftBranch.path, leaves[0].path]);
      const result0 = await parseTxPath({
        txRoot: root.hash,
        txPath: path0,
        targetOffset: BigInt(1010000), // Within TX 0
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 4,
      });
      assert(result0 !== null);
      assert.equal(result0.txIndex, 0);

      // Test TX 1
      const path1 = Buffer.concat([root.path, leftBranch.path, leaves[1].path]);
      const result1 = await parseTxPath({
        txRoot: root.hash,
        txPath: path1,
        targetOffset: BigInt(1035000), // Within TX 1
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 4,
      });
      assert(result1 !== null);
      assert.equal(result1.txIndex, 1);

      // Test TX 2
      const path2 = Buffer.concat([
        root.path,
        rightBranch.path,
        leaves[2].path,
      ]);
      const result2 = await parseTxPath({
        txRoot: root.hash,
        txPath: path2,
        targetOffset: BigInt(1060000), // Within TX 2
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 4,
      });
      assert(result2 !== null);
      assert.equal(result2.txIndex, 2);

      // Test TX 3 (rightmost)
      const path3 = Buffer.concat([
        root.path,
        rightBranch.path,
        leaves[3].path,
      ]);
      const result3 = await parseTxPath({
        txRoot: root.hash,
        txPath: path3,
        targetOffset: BigInt(1090000), // Within TX 3
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 4,
      });
      assert(result3 !== null);
      assert.equal(result3.txIndex, 3);
    });

    it('should reject path with invalid hash', async () => {
      const dataRoot = crypto.randomBytes(32);
      const leaf = await createTxLeafNode(dataRoot, BigInt(1100000));
      const wrongRoot = crypto.randomBytes(32); // Wrong tx_root

      const result = await parseTxPath({
        txRoot: wrongRoot,
        txPath: leaf.path,
        targetOffset: BigInt(1050000),
        blockWeaveSize: BigInt(1100000),
        prevBlockWeaveSize: BigInt(1000000),
        txCount: 1,
      });

      assert.equal(result, null, 'Should return null for invalid hash');
    });

    it('should reject path with tampered branch hash', async () => {
      const dataRoot1 = crypto.randomBytes(32);
      const dataRoot2 = crypto.randomBytes(32);
      const prevBlockWeaveSize = BigInt(1000000);
      const tx1EndOffset = BigInt(1050000);
      const tx2EndOffset = BigInt(1100000);

      const leaf1 = await createTxLeafNode(dataRoot1, tx1EndOffset);
      const leaf2 = await createTxLeafNode(dataRoot2, tx2EndOffset);
      const branch = await createTxBranchNode(
        leaf1.hash,
        leaf2.hash,
        tx1EndOffset,
      );

      // Tamper with the branch path (flip a bit)
      const tamperedPath = Buffer.concat([branch.path, leaf1.path]);
      tamperedPath[0] ^= 0xff;

      const result = await parseTxPath({
        txRoot: branch.hash,
        txPath: tamperedPath,
        targetOffset: BigInt(1025000),
        blockWeaveSize: tx2EndOffset,
        prevBlockWeaveSize,
        txCount: 2,
      });

      assert.equal(result, null, 'Should return null for tampered path');
    });

    it('should return null for empty block', async () => {
      const result = await parseTxPath({
        txRoot: crypto.randomBytes(32),
        txPath: Buffer.alloc(64),
        targetOffset: BigInt(1050000),
        blockWeaveSize: BigInt(1100000),
        prevBlockWeaveSize: BigInt(1000000),
        txCount: 0, // Empty block
      });

      assert.equal(result, null, 'Should return null for empty block');
    });

    it('should return null for path shorter than minimum', async () => {
      const result = await parseTxPath({
        txRoot: crypto.randomBytes(32),
        txPath: Buffer.alloc(32), // Too short (minimum is 64)
        targetOffset: BigInt(1050000),
        blockWeaveSize: BigInt(1100000),
        prevBlockWeaveSize: BigInt(1000000),
        txCount: 1,
      });

      assert.equal(result, null, 'Should return null for short path');
    });

    it('should return null for misaligned path', async () => {
      const result = await parseTxPath({
        txRoot: crypto.randomBytes(32),
        txPath: Buffer.alloc(100), // Not aligned (not 64 + n*96)
        targetOffset: BigInt(1050000),
        blockWeaveSize: BigInt(1100000),
        prevBlockWeaveSize: BigInt(1000000),
        txCount: 1,
      });

      assert.equal(result, null, 'Should return null for misaligned path');
    });

    it('should handle large offsets exceeding Number.MAX_SAFE_INTEGER', async () => {
      const dataRoot = crypto.randomBytes(32);
      // Use an offset larger than Number.MAX_SAFE_INTEGER (2^53 - 1)
      const largeOffset = BigInt('10000000000000000000'); // ~10 exabytes
      const prevBlockWeaveSize = largeOffset - BigInt(100000);
      const blockWeaveSize = largeOffset;

      const leaf = await createTxLeafNode(dataRoot, largeOffset);

      const result = await parseTxPath({
        txRoot: leaf.hash,
        txPath: leaf.path,
        targetOffset: largeOffset - BigInt(50000), // Within the TX range
        blockWeaveSize,
        prevBlockWeaveSize,
        txCount: 1,
      });

      assert(result !== null, 'Result should not be null for large offsets');
      assert.equal(result.validated, true);
      assert.equal(result.txIndex, 0);
      assert.equal(result.txEndOffset, largeOffset);
      assert.equal(result.txStartOffset, prevBlockWeaveSize);
      assert.equal(result.txSize, largeOffset - prevBlockWeaveSize);
      assert(result.dataRoot.equals(dataRoot));
    });
  });

  describe('sortTxIdsByBinary', () => {
    it('should return empty array for empty input', () => {
      const result = sortTxIdsByBinary([]);
      assert.deepEqual(result, []);
    });

    it('should return same array for single element', () => {
      const txId = toB64Url(crypto.randomBytes(32));
      const result = sortTxIdsByBinary([txId]);
      assert.deepEqual(result, [txId]);
    });

    it('should sort by binary representation', () => {
      // Create TX IDs with known binary values for predictable sorting
      const buf1 = Buffer.alloc(32, 0x00); // All zeros (smallest)
      const buf2 = Buffer.alloc(32, 0x80); // Mid value
      const buf3 = Buffer.alloc(32, 0xff); // All ones (largest)

      const txIds = [
        toB64Url(buf3), // Largest first
        toB64Url(buf1), // Smallest
        toB64Url(buf2), // Middle
      ];

      const sorted = sortTxIdsByBinary(txIds);

      assert.equal(sorted[0], toB64Url(buf1), 'Smallest should be first');
      assert.equal(sorted[1], toB64Url(buf2), 'Middle should be second');
      assert.equal(sorted[2], toB64Url(buf3), 'Largest should be last');
    });

    it('should not modify original array', () => {
      const buf1 = Buffer.alloc(32, 0xff);
      const buf2 = Buffer.alloc(32, 0x00);
      const original = [toB64Url(buf1), toB64Url(buf2)];
      const originalCopy = [...original];

      sortTxIdsByBinary(original);

      assert.deepEqual(original, originalCopy, 'Original should be unchanged');
    });
  });

  describe('extractDataRootFromTxPath', () => {
    it('should extract dataRoot from valid path', async () => {
      const dataRoot = crypto.randomBytes(32);
      const leaf = await createTxLeafNode(dataRoot, BigInt(1000000));

      const extracted = extractDataRootFromTxPath(leaf.path);
      assert(extracted.equals(dataRoot), 'Extracted dataRoot should match');
    });

    it('should extract dataRoot from path with branches', async () => {
      const dataRoot = crypto.randomBytes(32);
      const leaf = await createTxLeafNode(dataRoot, BigInt(1000000));
      const branch = await createTxBranchNode(
        leaf.hash,
        crypto.randomBytes(32),
        BigInt(500000),
      );
      const fullPath = Buffer.concat([branch.path, leaf.path]);

      const extracted = extractDataRootFromTxPath(fullPath);
      assert(extracted.equals(dataRoot), 'Extracted dataRoot should match');
    });

    it('should throw for path too short', () => {
      assert.throws(
        () => extractDataRootFromTxPath(Buffer.alloc(32)),
        /too short/,
      );
    });
  });

  describe('extractTxEndOffsetFromTxPath', () => {
    it('should extract txEndOffset from valid path', async () => {
      const dataRoot = crypto.randomBytes(32);
      const txEndOffset = BigInt(12345678);
      const leaf = await createTxLeafNode(dataRoot, txEndOffset);

      const extracted = extractTxEndOffsetFromTxPath(leaf.path);
      assert.equal(extracted, txEndOffset);
    });

    it('should extract large txEndOffset exceeding Number.MAX_SAFE_INTEGER', async () => {
      const dataRoot = crypto.randomBytes(32);
      const txEndOffset = BigInt('10000000000000000000'); // ~10 exabytes
      const leaf = await createTxLeafNode(dataRoot, txEndOffset);

      const extracted = extractTxEndOffsetFromTxPath(leaf.path);
      assert.equal(extracted, txEndOffset);
    });

    it('should throw for path too short', () => {
      assert.throws(
        () => extractTxEndOffsetFromTxPath(Buffer.alloc(32)),
        /too short/,
      );
    });
  });

  describe('safeBigIntToNumber', () => {
    it('should convert small bigint to number', () => {
      const result = safeBigIntToNumber(BigInt(12345), 'test');
      assert.equal(result, 12345);
    });

    it('should convert Number.MAX_SAFE_INTEGER to number', () => {
      const result = safeBigIntToNumber(
        BigInt(Number.MAX_SAFE_INTEGER),
        'test',
      );
      assert.equal(result, Number.MAX_SAFE_INTEGER);
    });

    it('should throw for value exceeding Number.MAX_SAFE_INTEGER', () => {
      const largeValue = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1);
      assert.throws(
        () => safeBigIntToNumber(largeValue, 'testField'),
        /testField exceeds safe integer range/,
      );
    });
  });
});
