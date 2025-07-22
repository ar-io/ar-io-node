/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { validatePath } from 'arweave/node/lib/merkle.js';
import { parseDataPath, ValidationRuleset } from './merkle-path-parser.js';

// Helper to convert base64url to Buffer
function b64UrlToBuffer(b64urlstring: string): Buffer {
  return Buffer.from(b64urlstring, 'base64url');
}

// Load test data
const TEST_DATA = JSON.parse(
  readFileSync('test/mock_files/chunks/chunk-test-data.json', 'utf-8'),
);
const CHUNK_1 = JSON.parse(
  readFileSync('test/mock_files/chunks/351531360100599.json', 'utf-8'),
);

describe('merkle-path-parser arweave.js compatibility', () => {
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
