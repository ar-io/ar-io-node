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
import {
  parseDataPath,
  ValidationRuleset,
  getRulesetForOffset,
  extractNote,
  extractRoot,
} from './merkle-path-parser.js';

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
});
