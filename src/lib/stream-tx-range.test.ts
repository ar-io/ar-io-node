/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, mock } from 'node:test';
import winston from 'winston';
import crypto from 'node:crypto';
import { streamRangeData } from './stream-tx-range.js';
import { Chunk } from '../types.js';

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

// Helper to create a two-chunk tree structure for testing
async function createTwoChunkTree(
  chunk1Data: Buffer,
  chunk2Data: Buffer,
): Promise<{
  dataRoot: Buffer;
  chunk1Path: Buffer;
  chunk2Path: Buffer;
}> {
  const chunk1Size = chunk1Data.length;
  const chunk2Size = chunk2Data.length;

  // Create leaf hashes
  const chunk1DataHash = await hash(chunk1Data);
  const chunk2DataHash = await hash(chunk2Data);
  const chunk1Offset = intToBuffer(chunk1Size);
  const chunk2Offset = intToBuffer(chunk1Size + chunk2Size);

  const leaf1Hash = await hash([
    await hash(chunk1DataHash),
    await hash(chunk1Offset),
  ]);
  const leaf2Hash = await hash([
    await hash(chunk2DataHash),
    await hash(chunk2Offset),
  ]);

  // Create root
  const boundary = intToBuffer(chunk1Size);
  const dataRoot = await hash([
    await hash(leaf1Hash),
    await hash(leaf2Hash),
    await hash(boundary),
  ]);

  // Create paths
  const chunk1Path = Buffer.concat([
    leaf1Hash,
    leaf2Hash,
    boundary,
    chunk1DataHash,
    chunk1Offset,
  ]);

  const chunk2Path = Buffer.concat([
    leaf1Hash,
    leaf2Hash,
    boundary,
    chunk2DataHash,
    chunk2Offset,
  ]);

  return { dataRoot, chunk1Path, chunk2Path };
}

// Create a mock chunk
async function createMockChunk(
  data: Buffer,
  startOffset: number,
  endOffset: number,
  totalSize: number,
): Promise<Chunk> {
  const offsetBuffer = intToBuffer(endOffset);
  const dataHash = await hash(data);

  // For single chunk, create simple leaf path
  const dataPath = Buffer.concat([dataHash, offsetBuffer]);

  // Calculate the root hash for this path
  const dataRoot = await hash([await hash(dataHash), await hash(offsetBuffer)]);

  return {
    chunk: data,
    data_path: dataPath,
    data_root: dataRoot,
    data_size: totalSize,
    offset: startOffset,
    hash: dataHash,
    tx_path: undefined,
  };
}

describe('streamRangeData', () => {
  let mockLogger: winston.Logger;
  let mockGetChunkByAny: any;

  beforeEach(() => {
    // Create a mock logger
    mockLogger = {
      debug: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    } as any;

    // Reset mock
    mockGetChunkByAny = mock.fn();
  });

  it('should stream a range within a single chunk', async () => {
    const chunkData = Buffer.from('Hello, World! This is test data.');
    const chunkSize = chunkData.length;
    const mockChunk = await createMockChunk(chunkData, 0, chunkSize, chunkSize);

    mockGetChunkByAny.mock.mockImplementation(async () => mockChunk);

    const params = {
      txId: 'test-tx-id',
      txSize: chunkSize,
      txAbsoluteStart: 1000,
      dataRoot: mockChunk.data_root.toString('base64url'),
      rangeStart: 7,
      rangeEnd: 13, // "World!"
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    // Should have fetched one chunk
    assert.equal(mockGetChunkByAny.mock.calls.length, 1);
    assert.equal(result.getChunksFetched(), 1);

    // Should have yielded the correct range
    const data = Buffer.concat(chunks);
    assert.equal(data.toString(), 'World!');
  });

  it('should stream a range spanning multiple chunks', async () => {
    const chunk1Data = Buffer.alloc(256 * 1024, 'A'); // 256KB of 'A'
    const chunk2Data = Buffer.alloc(256 * 1024, 'B'); // 256KB of 'B'

    const totalSize = chunk1Data.length + chunk2Data.length;
    const { dataRoot, chunk1Path, chunk2Path } = await createTwoChunkTree(
      chunk1Data,
      chunk2Data,
    );

    const mockChunk1: Chunk = {
      chunk: chunk1Data,
      data_path: chunk1Path,
      data_root: dataRoot,
      data_size: totalSize,
      offset: 0,
      hash: await hash(chunk1Data),
      tx_path: undefined,
    };

    const mockChunk2: Chunk = {
      chunk: chunk2Data,
      data_path: chunk2Path,
      data_root: dataRoot,
      data_size: totalSize,
      offset: 256 * 1024,
      hash: await hash(chunk2Data),
      tx_path: undefined,
    };

    mockGetChunkByAny.mock.mockImplementation(async (params: any) => {
      const relOffset = params.relativeOffset;
      return relOffset < 256 * 1024 ? mockChunk1 : mockChunk2;
    });

    // Request range from middle of chunk1 to middle of chunk2
    const rangeStart = 200 * 1024; // Start in chunk1
    const rangeEnd = 300 * 1024; // End in chunk2

    const params = {
      txId: 'test-tx-id',
      txSize: totalSize,
      txAbsoluteStart: 1000,
      dataRoot: dataRoot.toString('base64url'),
      rangeStart,
      rangeEnd,
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    // Should have fetched two chunks
    assert.equal(mockGetChunkByAny.mock.calls.length, 2);
    assert.equal(result.getChunksFetched(), 2);

    // Verify the result
    const data = Buffer.concat(chunks);
    assert.equal(data.length, 100 * 1024); // 100KB total

    // First part should be 'A's (from chunk1)
    assert.equal(data[0], 65); // 'A'
    assert.equal(data[56 * 1024 - 1], 65); // Last 'A'

    // Second part should be 'B's (from chunk2)
    assert.equal(data[56 * 1024], 66); // First 'B'
    assert.equal(data[data.length - 1], 66); // Last 'B'
  });

  it('should handle single-byte range', async () => {
    const chunkData = Buffer.from('ABCDEFGHIJKLMNOP');
    const mockChunk = await createMockChunk(
      chunkData,
      0,
      chunkData.length,
      chunkData.length,
    );

    mockGetChunkByAny.mock.mockImplementation(async () => mockChunk);

    const params = {
      txId: 'test-tx-id',
      txSize: chunkData.length,
      txAbsoluteStart: 1000,
      dataRoot: mockChunk.data_root.toString('base64url'),
      rangeStart: 5,
      rangeEnd: 6, // Just 'F'
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    const data = Buffer.concat(chunks);
    assert.equal(data.length, 1);
    assert.equal(data.toString(), 'F');
    assert.equal(result.getChunksFetched(), 1);
  });

  it('should handle range at chunk boundary', async () => {
    const chunk1Data = Buffer.alloc(256 * 1024, 'X');
    const chunk2Data = Buffer.alloc(256 * 1024, 'Y');
    const totalSize = 512 * 1024;

    const { dataRoot, chunk1Path, chunk2Path } = await createTwoChunkTree(
      chunk1Data,
      chunk2Data,
    );

    const mockChunk1: Chunk = {
      chunk: chunk1Data,
      data_path: chunk1Path,
      data_root: dataRoot,
      data_size: totalSize,
      offset: 0,
      hash: await hash(chunk1Data),
      tx_path: undefined,
    };

    const mockChunk2: Chunk = {
      chunk: chunk2Data,
      data_path: chunk2Path,
      data_root: dataRoot,
      data_size: totalSize,
      offset: 256 * 1024,
      hash: await hash(chunk2Data),
      tx_path: undefined,
    };

    mockGetChunkByAny.mock.mockImplementation(async (params: any) => {
      return params.relativeOffset < 256 * 1024 ? mockChunk1 : mockChunk2;
    });

    // Range exactly at chunk boundary
    const params = {
      txId: 'test-tx-id',
      txSize: totalSize,
      txAbsoluteStart: 1000,
      dataRoot: dataRoot.toString('base64url'),
      rangeStart: 256 * 1024 - 1, // Last byte of chunk1
      rangeEnd: 256 * 1024 + 1, // First byte of chunk2
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    const data = Buffer.concat(chunks);
    assert.equal(data.length, 2);
    assert.equal(data[0], 88); // 'X'
    assert.equal(data[1], 89); // 'Y'
    assert.equal(result.getChunksFetched(), 2); // Should fetch both chunks
  });

  it('should handle empty range', async () => {
    const params = {
      txId: 'test-tx-id',
      txSize: 1000,
      txAbsoluteStart: 1000,
      dataRoot: 'dummy',
      rangeStart: 100,
      rangeEnd: 100, // Empty range
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 0);
    assert.equal(mockGetChunkByAny.mock.calls.length, 0);
    assert.equal(mockLogger.warn.mock.calls.length, 1);
    assert.equal(result.getChunksFetched(), 0);
  });

  it('should handle invalid range (start > end)', async () => {
    const params = {
      txId: 'test-tx-id',
      txSize: 1000,
      txAbsoluteStart: 1000,
      dataRoot: 'dummy',
      rangeStart: 200,
      rangeEnd: 100, // Invalid
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 0);
    assert.equal(mockGetChunkByAny.mock.calls.length, 0);
    assert.equal(mockLogger.warn.mock.calls.length, 1);
    assert.equal(result.getChunksFetched(), 0);
  });

  it('should handle range beyond file size', async () => {
    const params = {
      txId: 'test-tx-id',
      txSize: 1000,
      txAbsoluteStart: 1000,
      dataRoot: 'dummy',
      rangeStart: 900,
      rangeEnd: 1100, // Beyond txSize
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    assert.equal(chunks.length, 0);
    assert.equal(mockGetChunkByAny.mock.calls.length, 0);
    assert.equal(mockLogger.warn.mock.calls.length, 1);
    assert.equal(result.getChunksFetched(), 0);
  });

  it('should throw on chunk fetch error', async () => {
    mockGetChunkByAny.mock.mockImplementation(async () => {
      throw new Error('Network error');
    });

    const params = {
      txId: 'test-tx-id',
      txSize: 1000,
      txAbsoluteStart: 1000,
      dataRoot: 'dummy',
      rangeStart: 0,
      rangeEnd: 100,
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    await assert.rejects(async () => {
      const result = streamRangeData(params);
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk);
      }
    }, /Network error/);

    assert.equal(mockLogger.error.mock.calls.length, 1);
  });

  it('should handle last chunk being smaller', async () => {
    const chunk1Data = Buffer.alloc(256 * 1024, 'A');
    const chunk2Data = Buffer.from('Last chunk data'); // Small last chunk
    const totalSize = chunk1Data.length + chunk2Data.length;

    const { dataRoot, chunk1Path, chunk2Path } = await createTwoChunkTree(
      chunk1Data,
      chunk2Data,
    );

    const mockChunk1: Chunk = {
      chunk: chunk1Data,
      data_path: chunk1Path,
      data_root: dataRoot,
      data_size: totalSize,
      offset: 0,
      hash: await hash(chunk1Data),
      tx_path: undefined,
    };

    const mockChunk2: Chunk = {
      chunk: chunk2Data,
      data_path: chunk2Path,
      data_root: dataRoot,
      data_size: totalSize,
      offset: 256 * 1024,
      hash: await hash(chunk2Data),
      tx_path: undefined,
    };

    mockGetChunkByAny.mock.mockImplementation(async (params: any) => {
      return params.relativeOffset < 256 * 1024 ? mockChunk1 : mockChunk2;
    });

    // Request range in the last chunk
    const params = {
      txId: 'test-tx-id',
      txSize: totalSize,
      txAbsoluteStart: 1000,
      dataRoot: dataRoot.toString('base64url'),
      rangeStart: 256 * 1024 + 5,
      rangeEnd: 256 * 1024 + 10, // "chunk"
      getChunkByAny: mockGetChunkByAny,
      log: mockLogger,
    };

    const result = streamRangeData(params);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(chunk);
    }

    const data = Buffer.concat(chunks);
    assert.equal(data.toString(), 'chunk');
    assert.equal(result.getChunksFetched(), 1);
  });
});
