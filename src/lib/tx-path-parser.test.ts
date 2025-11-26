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
      // tx_path stores RELATIVE offsets within the block
      const relativeEndOffset = txEndOffset - prevBlockWeaveSize;

      const leaf = await createTxLeafNode(dataRoot, relativeEndOffset);

      const { result } = await parseTxPath({
        txRoot: leaf.hash,
        txPath: leaf.path,
        targetOffset: BigInt(1050000), // Absolute weave offset within TX range
        blockWeaveSize,
        prevBlockWeaveSize,
      });

      assert(result !== null, 'Result should not be null');
      assert.equal(result.validated, true);
      // Result txEndOffset is converted back to absolute
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
      const tx1EndOffset = BigInt(1050000); // TX 1 ends here (absolute)
      const tx2EndOffset = BigInt(1100000); // TX 2 ends here (absolute)
      const blockWeaveSize = tx2EndOffset;

      // tx_path stores RELATIVE offsets within the block
      const relativeTx1EndOffset = tx1EndOffset - prevBlockWeaveSize;
      const relativeTx2EndOffset = tx2EndOffset - prevBlockWeaveSize;

      // Build the tree: branch -> [leaf1, leaf2]
      const leaf1 = await createTxLeafNode(dataRoot1, relativeTx1EndOffset);
      const leaf2 = await createTxLeafNode(dataRoot2, relativeTx2EndOffset);
      const branch = await createTxBranchNode(
        leaf1.hash,
        leaf2.hash,
        relativeTx1EndOffset, // Boundary at TX 1's end offset (relative)
      );

      // Path for TX 1 (left subtree): branch + leaf1
      const path1 = Buffer.concat([branch.path, leaf1.path]);
      const { result: result1 } = await parseTxPath({
        txRoot: branch.hash,
        txPath: path1,
        targetOffset: BigInt(1025000), // Within TX 1 (absolute)
        blockWeaveSize,
        prevBlockWeaveSize,
      });

      assert(result1 !== null, 'Result1 should not be null');
      // Results are converted back to absolute offsets
      assert.equal(result1.txEndOffset, tx1EndOffset);
      assert.equal(result1.txStartOffset, prevBlockWeaveSize);
      assert(result1.dataRoot.equals(dataRoot1));
    });

    it('should track index correctly in two-TX block (right subtree)', async () => {
      const dataRoot1 = crypto.randomBytes(32);
      const dataRoot2 = crypto.randomBytes(32);
      const prevBlockWeaveSize = BigInt(1000000);
      const tx1EndOffset = BigInt(1050000); // Absolute
      const tx2EndOffset = BigInt(1100000); // Absolute
      const blockWeaveSize = tx2EndOffset;

      // tx_path stores RELATIVE offsets within the block
      const relativeTx1EndOffset = tx1EndOffset - prevBlockWeaveSize;
      const relativeTx2EndOffset = tx2EndOffset - prevBlockWeaveSize;

      const leaf1 = await createTxLeafNode(dataRoot1, relativeTx1EndOffset);
      const leaf2 = await createTxLeafNode(dataRoot2, relativeTx2EndOffset);
      const branch = await createTxBranchNode(
        leaf1.hash,
        leaf2.hash,
        relativeTx1EndOffset, // Relative boundary
      );

      // Path for TX 2 (right subtree): branch + leaf2
      const path2 = Buffer.concat([branch.path, leaf2.path]);
      const { result: result2 } = await parseTxPath({
        txRoot: branch.hash,
        txPath: path2,
        targetOffset: BigInt(1075000), // Within TX 2 (absolute)
        blockWeaveSize,
        prevBlockWeaveSize,
      });

      assert(result2 !== null, 'Result2 should not be null');
      // Results are converted back to absolute offsets
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
      // Absolute offsets for each TX's end
      const absoluteOffsets = [
        BigInt(1025000),
        BigInt(1050000),
        BigInt(1075000),
        BigInt(1100000),
      ];
      const blockWeaveSize = absoluteOffsets[3];

      // tx_path stores RELATIVE offsets within the block
      const relativeOffsets = absoluteOffsets.map(
        (o) => o - prevBlockWeaveSize,
      );

      // Create leaves with relative offsets
      const leaves = await Promise.all(
        dataRoots.map((dr, i) => createTxLeafNode(dr, relativeOffsets[i])),
      );

      // Create level 1 branches (left: tx0+tx1, right: tx2+tx3)
      const leftBranch = await createTxBranchNode(
        leaves[0].hash,
        leaves[1].hash,
        relativeOffsets[0], // Boundary between tx0 and tx1 (relative)
      );
      const rightBranch = await createTxBranchNode(
        leaves[2].hash,
        leaves[3].hash,
        relativeOffsets[2], // Boundary between tx2 and tx3 (relative)
      );

      // Create root branch
      const root = await createTxBranchNode(
        leftBranch.hash,
        rightBranch.hash,
        relativeOffsets[1], // Boundary between left and right subtrees (relative)
      );

      // Test TX 0 (leftmost)
      const path0 = Buffer.concat([root.path, leftBranch.path, leaves[0].path]);
      const { result: result0 } = await parseTxPath({
        txRoot: root.hash,
        txPath: path0,
        targetOffset: BigInt(1010000), // Within TX 0 (absolute)
        blockWeaveSize,
        prevBlockWeaveSize,
      });
      assert(result0 !== null);

      // Test TX 1
      const path1 = Buffer.concat([root.path, leftBranch.path, leaves[1].path]);
      const { result: result1 } = await parseTxPath({
        txRoot: root.hash,
        txPath: path1,
        targetOffset: BigInt(1035000), // Within TX 1 (absolute)
        blockWeaveSize,
        prevBlockWeaveSize,
      });
      assert(result1 !== null);

      // Test TX 2
      const path2 = Buffer.concat([
        root.path,
        rightBranch.path,
        leaves[2].path,
      ]);
      const { result: result2 } = await parseTxPath({
        txRoot: root.hash,
        txPath: path2,
        targetOffset: BigInt(1060000), // Within TX 2 (absolute)
        blockWeaveSize,
        prevBlockWeaveSize,
      });
      assert(result2 !== null);

      // Test TX 3 (rightmost)
      const path3 = Buffer.concat([
        root.path,
        rightBranch.path,
        leaves[3].path,
      ]);
      const { result: result3 } = await parseTxPath({
        txRoot: root.hash,
        txPath: path3,
        targetOffset: BigInt(1090000), // Within TX 3 (absolute)
        blockWeaveSize,
        prevBlockWeaveSize,
      });
      assert(result3 !== null);
    });

    it('should reject path with invalid hash', async () => {
      const dataRoot = crypto.randomBytes(32);
      const leaf = await createTxLeafNode(dataRoot, BigInt(1100000));
      const wrongRoot = crypto.randomBytes(32); // Wrong tx_root

      const { result } = await parseTxPath({
        txRoot: wrongRoot,
        txPath: leaf.path,
        targetOffset: BigInt(1050000),
        blockWeaveSize: BigInt(1100000),
        prevBlockWeaveSize: BigInt(1000000),
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

      const { result } = await parseTxPath({
        txRoot: branch.hash,
        txPath: tamperedPath,
        targetOffset: BigInt(1025000),
        blockWeaveSize: tx2EndOffset,
        prevBlockWeaveSize,
      });

      assert.equal(result, null, 'Should return null for tampered path');
    });

    it('should return null for path shorter than minimum', async () => {
      const { result } = await parseTxPath({
        txRoot: crypto.randomBytes(32),
        txPath: Buffer.alloc(32), // Too short (minimum is 64)
        targetOffset: BigInt(1050000),
        blockWeaveSize: BigInt(1100000),
        prevBlockWeaveSize: BigInt(1000000),
      });

      assert.equal(result, null, 'Should return null for short path');
    });

    it('should return null for misaligned path', async () => {
      const { result } = await parseTxPath({
        txRoot: crypto.randomBytes(32),
        txPath: Buffer.alloc(100), // Not aligned (not 64 + n*96)
        targetOffset: BigInt(1050000),
        blockWeaveSize: BigInt(1100000),
        prevBlockWeaveSize: BigInt(1000000),
      });

      assert.equal(result, null, 'Should return null for misaligned path');
    });

    it('should handle large offsets exceeding Number.MAX_SAFE_INTEGER', async () => {
      const dataRoot = crypto.randomBytes(32);
      // Use an offset larger than Number.MAX_SAFE_INTEGER (2^53 - 1)
      const largeOffset = BigInt('10000000000000000000'); // ~10 exabytes (absolute)
      const prevBlockWeaveSize = largeOffset - BigInt(100000);
      const blockWeaveSize = largeOffset;

      // tx_path stores RELATIVE offsets within the block
      const relativeEndOffset = largeOffset - prevBlockWeaveSize;
      const leaf = await createTxLeafNode(dataRoot, relativeEndOffset);

      const { result } = await parseTxPath({
        txRoot: leaf.hash,
        txPath: leaf.path,
        targetOffset: largeOffset - BigInt(50000), // Within the TX range (absolute)
        blockWeaveSize,
        prevBlockWeaveSize,
      });

      assert(result !== null, 'Result should not be null for large offsets');
      assert.equal(result.validated, true);
      // Results are converted back to absolute offsets
      assert.equal(result.txEndOffset, largeOffset);
      assert.equal(result.txStartOffset, prevBlockWeaveSize);
      assert.equal(result.txSize, largeOffset - prevBlockWeaveSize);
      assert(result.dataRoot.equals(dataRoot));
    });

    it('should parse real tx_path from arweave.net chunk at offset 345449412246841', async () => {
      // Real data from arweave.net for chunk at offset 345449412246841
      // Block 1700011 contains this transaction
      const txPathB64 =
        'sTUh0vO-WLCLcQBmJkiSaNN-MCr9MSudPr7rhTQ-hzuIIWuarkgoxV4-ZG7MzmUie_vPGyxodraOp6to0dH9NgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATgAxCjY5HaedJPJPmvGXXHnWwRIq2BosulRQvXHHeIiMBR5r2wV8qJ_S2-5b_p6hCiFW8W3UfISIaW4TMCO-XM5m4kQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYjJxDxTVQX0-XYx0t0NmC_tJRl6eF2lq1SCHIGcS8w1Ck9tWmpN30eCOs-iDpR91EbW0lrv3eH8KWdmSjRa3d5df7PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAThTrsCmpaQ1sosO568-yWsS3gACQQ5TwiH__4tZ7A6CErLzsj6S5_HEi62u3PYqFDUJrS9mDRHGsfD9jIV6rp_2vazgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATiAAAym3Ru53ltXtgk-N00MCQ1NR84NkafeheORYNYg58dLYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGIycQw';

      const txRootB64 = '7ROH2BJvqVL8exgIBxpVD7YCoAE8DhjFaWHttze-Gyg';

      // Block 1700011 info:
      // - weave_size: 345449412468982
      // - Previous block (1700010) weave_size: 345449000378614
      // - txs count: 35
      const blockWeaveSize = BigInt('345449412468982');
      const prevBlockWeaveSize = BigInt('345449000378614');
      const targetOffset = BigInt('345449412246841');

      const txPath = Buffer.from(txPathB64, 'base64url');
      const txRoot = Buffer.from(txRootB64, 'base64url');

      const { result, rejectionReason, branchCount } = await parseTxPath({
        txRoot,
        txPath,
        targetOffset,
        blockWeaveSize,
        prevBlockWeaveSize,
      });

      // Debug info if it fails
      if (result === null) {
        console.log('Rejection reason:', rejectionReason);
        console.log('Branch count:', branchCount);
        console.log('txPath length:', txPath.length);
      }

      assert(
        result !== null,
        `Result should not be null. Rejection reason: ${rejectionReason}`,
      );
      assert.equal(result.validated, true);

      // The dataRoot from the tx_path should be:
      // ym3Ru53ltXtgk-N00MCQ1NR84NkafeheORYNYg58dLY (from the chunk response)
      const expectedDataRoot = Buffer.from(
        'ym3Ru53ltXtgk-N00MCQ1NR84NkafeheORYNYg58dLY',
        'base64url',
      );
      assert(
        result.dataRoot.equals(expectedDataRoot),
        'dataRoot should match expected',
      );

      // The txEndOffset from the leaf is the TX's end offset (relative 411868227 + prevBlockWeaveSize)
      assert.equal(
        result.txEndOffset,
        BigInt('345449412246841'),
        'txEndOffset should match',
      );
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
