/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, describe, it, mock } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import {
  Chunk,
  ChunkByAnySource,
  ChunkData,
  ChunkDataStore,
  ChunkMetadata,
  ChunkMetadataStore,
  TxOffsetSource,
  UnvalidatedChunk,
  UnvalidatedChunkSource,
} from '../types.js';
import {
  ChunkNotFoundError,
  ChunkRetrievalService,
  hasTxId,
  usedFastPath,
} from './chunk-retrieval-service.js';

// Test constants
const B64_DATA_ROOT = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
const TX_ID = 'test-tx-id-12345';
const TX_SIZE = 256000;
const ABSOLUTE_OFFSET = 51530681327863;
const RELATIVE_OFFSET = 0;
const WEAVE_OFFSET = ABSOLUTE_OFFSET + TX_SIZE - 1;
const CONTIGUOUS_START = ABSOLUTE_OFFSET;

// Mock data
const mockDataRoot = fromB64Url(B64_DATA_ROOT);
const mockHash = Buffer.alloc(32, 1);
const mockChunkData = Buffer.alloc(256, 2);
const mockDataPath = Buffer.alloc(64, 3);
const mockTxPath = Buffer.alloc(64, 4);

const mockChunkDataResult: ChunkData = {
  hash: mockHash,
  chunk: mockChunkData,
};

const mockChunkMetadata: ChunkMetadata = {
  data_root: mockDataRoot,
  data_size: TX_SIZE,
  data_path: mockDataPath,
  offset: RELATIVE_OFFSET,
  hash: mockHash,
  tx_path: mockTxPath,
};

const mockChunk: Chunk = {
  ...mockChunkDataResult,
  ...mockChunkMetadata,
  source: 'peer',
  sourceHost: 'test-peer.example.com',
};

let log: ReturnType<typeof createTestLogger>;

// Mock implementations
const createMockChunkDataStore = (): ChunkDataStore => ({
  get: mock.fn(async () => undefined),
  set: mock.fn(async () => {}),
  has: mock.fn(async () => false),
  getByAbsoluteOffset: mock.fn(async () => undefined),
});

const createMockChunkMetadataStore = (): ChunkMetadataStore => ({
  get: mock.fn(async () => undefined),
  set: mock.fn(async () => {}),
  has: mock.fn(async () => false),
  getByAbsoluteOffset: mock.fn(async () => undefined),
});

const createMockTxOffsetSource = (): TxOffsetSource => ({
  getTxByOffset: mock.fn(async () => ({
    data_root: B64_DATA_ROOT,
    id: TX_ID,
    data_size: TX_SIZE,
    offset: WEAVE_OFFSET,
  })),
});

const createMockChunkSource = (): ChunkByAnySource => ({
  getChunkByAny: mock.fn(async () => mockChunk),
});

const createMockUnvalidatedChunkSource = (): UnvalidatedChunkSource => ({
  getUnvalidatedChunk: mock.fn(async () => ({
    chunk: mockChunkData,
    data_path: mockDataPath,
    tx_path: mockTxPath,
    hash: mockHash,
    source: 'peer',
    sourceHost: 'test-peer.example.com',
  })),
});

before(() => {
  log = createTestLogger({ suite: 'ChunkRetrievalService' });
});

describe('ChunkRetrievalService', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('Type guards', () => {
    it('hasTxId returns true only for fallback results', () => {
      const cacheHitResult = {
        type: 'cache_hit' as const,
        chunk: mockChunk,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      const fallbackResult = {
        type: 'fallback' as const,
        chunk: mockChunk,
        txId: TX_ID,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      assert.equal(hasTxId(cacheHitResult), false);
      assert.equal(hasTxId(fallbackResult), true);
    });

    it('usedFastPath returns true for cache_hit and tx_path_validated', () => {
      const cacheHitResult = {
        type: 'cache_hit' as const,
        chunk: mockChunk,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      const txPathResult = {
        type: 'tx_path_validated' as const,
        chunk: mockChunk,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      const fallbackResult = {
        type: 'fallback' as const,
        chunk: mockChunk,
        txId: TX_ID,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      assert.equal(usedFastPath(cacheHitResult), true);
      assert.equal(usedFastPath(txPathResult), true);
      assert.equal(usedFastPath(fallbackResult), false);
    });
  });

  describe('retrieveChunk - cache hit path', () => {
    it('should return CacheHitResult when chunk is in cache', async () => {
      const chunkDataStore = createMockChunkDataStore();
      const chunkMetadataStore = createMockChunkMetadataStore();
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      // Mock cache hit
      (chunkDataStore.getByAbsoluteOffset as any).mock.mockImplementation(
        async () => mockChunkDataResult,
      );
      (chunkMetadataStore.getByAbsoluteOffset as any).mock.mockImplementation(
        async () => mockChunkMetadata,
      );

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
        chunkDataStore,
        chunkMetadataStore,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      assert.equal(result.type, 'cache_hit');
      assert.equal(usedFastPath(result), true);
      assert.equal(hasTxId(result), false);
      assert.equal(result.dataRoot, B64_DATA_ROOT);
      assert.equal(result.dataSize, TX_SIZE);
      assert.equal(result.chunk.source, 'cache');

      // Verify cache was checked
      assert.equal(
        (chunkDataStore.getByAbsoluteOffset as any).mock.callCount(),
        1,
      );
      assert.equal(
        (chunkMetadataStore.getByAbsoluteOffset as any).mock.callCount(),
        1,
      );

      // Verify fallback was NOT called
      assert.equal((txOffsetSource.getTxByOffset as any).mock.callCount(), 0);
      assert.equal((chunkSource.getChunkByAny as any).mock.callCount(), 0);
    });
  });

  describe('retrieveChunk - fallback path', () => {
    it('should return FallbackResult when cache misses and no tx_path validation available', async () => {
      const chunkDataStore = createMockChunkDataStore();
      const chunkMetadataStore = createMockChunkMetadataStore();
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      // Mock cache miss (default behavior - returns undefined)

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
        chunkDataStore,
        chunkMetadataStore,
        // No unvalidatedChunkSource or arweaveClient - skips tx_path validation
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      assert.equal(result.type, 'fallback');
      assert.equal(usedFastPath(result), false);
      assert.equal(hasTxId(result), true);
      if (hasTxId(result)) {
        assert.equal(result.txId, TX_ID);
      }
      assert.equal(result.dataRoot, B64_DATA_ROOT);
      assert.equal(result.dataSize, TX_SIZE);

      // Verify fallback was called
      assert.equal((txOffsetSource.getTxByOffset as any).mock.callCount(), 1);
      assert.equal((chunkSource.getChunkByAny as any).mock.callCount(), 1);
    });

    it('should return FallbackResult when fast path dependencies are not provided', async () => {
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
        // No chunkDataStore or chunkMetadataStore - skips fast path entirely
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      assert.equal(result.type, 'fallback');
      assert.equal(hasTxId(result), true);
    });

    it('should throw ChunkNotFoundError when txOffsetSource fails', async () => {
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      (txOffsetSource.getTxByOffset as any).mock.mockImplementation(
        async () => {
          throw new Error('Database error');
        },
      );

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
      });

      await assert.rejects(
        () => service.retrieveChunk(ABSOLUTE_OFFSET),
        (error: any) => {
          assert(error instanceof ChunkNotFoundError);
          assert.equal(error.errorType, 'offset_lookup_failed');
          return true;
        },
      );
    });

    it('should throw ChunkNotFoundError when TX info is incomplete', async () => {
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      (txOffsetSource.getTxByOffset as any).mock.mockImplementation(
        async () => ({
          data_root: undefined,
          id: TX_ID,
          data_size: TX_SIZE,
          offset: WEAVE_OFFSET,
        }),
      );

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
      });

      await assert.rejects(
        () => service.retrieveChunk(ABSOLUTE_OFFSET),
        (error: any) => {
          assert(error instanceof ChunkNotFoundError);
          assert.equal(error.errorType, 'tx_not_found');
          return true;
        },
      );
    });

    it('should throw ChunkNotFoundError when chunk fetch fails', async () => {
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      (chunkSource.getChunkByAny as any).mock.mockImplementation(async () => {
        throw new Error('Network error');
      });

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
      });

      await assert.rejects(
        () => service.retrieveChunk(ABSOLUTE_OFFSET),
        (error: any) => {
          assert(error instanceof ChunkNotFoundError);
          assert.equal(error.errorType, 'fetch_failed');
          return true;
        },
      );
    });
  });

  describe('retrieveChunk - cache miss with fallback', () => {
    it('should fall through to fallback when both cache stores miss', async () => {
      const chunkDataStore = createMockChunkDataStore();
      const chunkMetadataStore = createMockChunkMetadataStore();
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      // Cache miss - only one store returns data
      (chunkDataStore.getByAbsoluteOffset as any).mock.mockImplementation(
        async () => mockChunkDataResult,
      );
      // chunkMetadataStore returns undefined (default)

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
        chunkDataStore,
        chunkMetadataStore,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      // Should fall through to fallback since metadata is missing
      assert.equal(result.type, 'fallback');
      assert.equal((txOffsetSource.getTxByOffset as any).mock.callCount(), 1);
    });
  });

  describe('Discriminated union type narrowing', () => {
    it('should allow type-safe access to txId only on FallbackResult', async () => {
      const txOffsetSource = createMockTxOffsetSource();
      const chunkSource = createMockChunkSource();

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txOffsetSource,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      // Type narrowing via switch
      switch (result.type) {
        case 'cache_hit':
          // TypeScript knows txId doesn't exist here
          assert.equal(result.type, 'cache_hit');
          break;
        case 'tx_path_validated':
          // TypeScript knows txId doesn't exist here
          assert.equal(result.type, 'tx_path_validated');
          break;
        case 'fallback':
          // TypeScript knows txId exists and is string
          assert.equal(typeof result.txId, 'string');
          assert.equal(result.txId, TX_ID);
          break;
      }

      // Type narrowing via type guard
      if (hasTxId(result)) {
        // TypeScript knows result is FallbackResult
        assert.equal(result.txId, TX_ID);
      }
    });
  });
});
