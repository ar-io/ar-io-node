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
  TxBoundary,
  TxBoundarySource,
} from '../types.js';
import {
  ChunkNotFoundError,
  ChunkRetrievalService,
  hasTxId,
  usedCachePath,
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

const createMockTxBoundarySource = (): TxBoundarySource => ({
  getTxBoundary: mock.fn(
    async (): Promise<TxBoundary | null> => ({
      dataRoot: B64_DATA_ROOT,
      id: TX_ID,
      dataSize: TX_SIZE,
      weaveOffset: WEAVE_OFFSET,
    }),
  ),
});

const createMockChunkSource = (): ChunkByAnySource => ({
  getChunkByAny: mock.fn(async () => mockChunk),
});

before(() => {
  log = createTestLogger({ suite: 'ChunkRetrievalService' });
});

describe('ChunkRetrievalService', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('Type guards', () => {
    it('hasTxId returns true only for boundary_fetch results with txId', () => {
      const cacheHitResult = {
        type: 'cache_hit' as const,
        chunk: mockChunk,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      const boundaryFetchWithTxId = {
        type: 'boundary_fetch' as const,
        chunk: mockChunk,
        txId: TX_ID,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      const boundaryFetchWithoutTxId = {
        type: 'boundary_fetch' as const,
        chunk: mockChunk,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      assert.equal(hasTxId(cacheHitResult), false);
      assert.equal(hasTxId(boundaryFetchWithTxId), true);
      assert.equal(hasTxId(boundaryFetchWithoutTxId), false);
    });

    it('usedCachePath returns true only for cache_hit', () => {
      const cacheHitResult = {
        type: 'cache_hit' as const,
        chunk: mockChunk,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      const boundaryFetchResult = {
        type: 'boundary_fetch' as const,
        chunk: mockChunk,
        txId: TX_ID,
        dataRoot: B64_DATA_ROOT,
        dataSize: TX_SIZE,
        weaveOffset: WEAVE_OFFSET,
        relativeOffset: RELATIVE_OFFSET,
        contiguousDataStartDelimiter: CONTIGUOUS_START,
      };

      assert.equal(usedCachePath(cacheHitResult), true);
      assert.equal(usedCachePath(boundaryFetchResult), false);
    });
  });

  describe('retrieveChunk - cache hit path', () => {
    it('should return CacheHitResult when chunk is in cache', async () => {
      const chunkDataStore = createMockChunkDataStore();
      const chunkMetadataStore = createMockChunkMetadataStore();
      const txBoundarySource = createMockTxBoundarySource();
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
        txBoundarySource,
        chunkDataStore,
        chunkMetadataStore,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      assert.equal(result.type, 'cache_hit');
      assert.equal(usedCachePath(result), true);
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

      // Verify boundary source was NOT called
      assert.equal((txBoundarySource.getTxBoundary as any).mock.callCount(), 0);
      assert.equal((chunkSource.getChunkByAny as any).mock.callCount(), 0);
    });
  });

  describe('retrieveChunk - boundary fetch path', () => {
    it('should return BoundaryFetchResult when cache misses', async () => {
      const chunkDataStore = createMockChunkDataStore();
      const chunkMetadataStore = createMockChunkMetadataStore();
      const txBoundarySource = createMockTxBoundarySource();
      const chunkSource = createMockChunkSource();

      // Mock cache miss (default behavior - returns undefined)

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txBoundarySource,
        chunkDataStore,
        chunkMetadataStore,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      assert.equal(result.type, 'boundary_fetch');
      assert.equal(usedCachePath(result), false);
      assert.equal(hasTxId(result), true);
      if (hasTxId(result)) {
        assert.equal(result.txId, TX_ID);
      }
      assert.equal(result.dataRoot, B64_DATA_ROOT);
      assert.equal(result.dataSize, TX_SIZE);

      // Verify boundary source was called
      assert.equal((txBoundarySource.getTxBoundary as any).mock.callCount(), 1);
      assert.equal((chunkSource.getChunkByAny as any).mock.callCount(), 1);
    });

    it('should return BoundaryFetchResult when cache stores not provided', async () => {
      const txBoundarySource = createMockTxBoundarySource();
      const chunkSource = createMockChunkSource();

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txBoundarySource,
        // No chunkDataStore or chunkMetadataStore - skips cache path entirely
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      assert.equal(result.type, 'boundary_fetch');
      assert.equal(hasTxId(result), true);
    });

    it('should throw ChunkNotFoundError when txBoundarySource returns null', async () => {
      const txBoundarySource = createMockTxBoundarySource();
      const chunkSource = createMockChunkSource();

      (txBoundarySource.getTxBoundary as any).mock.mockImplementation(
        async () => null,
      );

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txBoundarySource,
      });

      await assert.rejects(
        () => service.retrieveChunk(ABSOLUTE_OFFSET),
        (error: any) => {
          assert(error instanceof ChunkNotFoundError);
          assert.equal(error.errorType, 'boundary_not_found');
          return true;
        },
      );
    });

    it('should throw ChunkNotFoundError when chunk fetch fails', async () => {
      const txBoundarySource = createMockTxBoundarySource();
      const chunkSource = createMockChunkSource();

      (chunkSource.getChunkByAny as any).mock.mockImplementation(async () => {
        throw new Error('Network error');
      });

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txBoundarySource,
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

  describe('retrieveChunk - cache miss with boundary fetch', () => {
    it('should fall through to boundary fetch when only one cache store has data', async () => {
      const chunkDataStore = createMockChunkDataStore();
      const chunkMetadataStore = createMockChunkMetadataStore();
      const txBoundarySource = createMockTxBoundarySource();
      const chunkSource = createMockChunkSource();

      // Cache miss - only one store returns data
      (chunkDataStore.getByAbsoluteOffset as any).mock.mockImplementation(
        async () => mockChunkDataResult,
      );
      // chunkMetadataStore returns undefined (default)

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txBoundarySource,
        chunkDataStore,
        chunkMetadataStore,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      // Should fall through to boundary fetch since metadata is missing
      assert.equal(result.type, 'boundary_fetch');
      assert.equal((txBoundarySource.getTxBoundary as any).mock.callCount(), 1);
    });
  });

  describe('Discriminated union type narrowing', () => {
    it('should allow type-safe access to txId only on BoundaryFetchResult with txId', async () => {
      const txBoundarySource = createMockTxBoundarySource();
      const chunkSource = createMockChunkSource();

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txBoundarySource,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      // Type narrowing via switch
      switch (result.type) {
        case 'cache_hit':
          // TypeScript knows txId doesn't exist here
          assert.equal(result.type, 'cache_hit');
          break;
        case 'boundary_fetch':
          // TypeScript knows txId may exist
          if (result.txId !== undefined) {
            assert.equal(typeof result.txId, 'string');
            assert.equal(result.txId, TX_ID);
          }
          break;
      }

      // Type narrowing via hasTxId guard
      if (hasTxId(result)) {
        assert.equal(result.txId, TX_ID);
      }
    });
  });

  describe('BoundaryFetchResult without txId', () => {
    it('should return BoundaryFetchResult without txId when boundary has no id', async () => {
      const txBoundarySource = createMockTxBoundarySource();
      const chunkSource = createMockChunkSource();

      // Boundary without txId (e.g., from tx_path validation)
      (txBoundarySource.getTxBoundary as any).mock.mockImplementation(
        async (): Promise<TxBoundary> => ({
          dataRoot: B64_DATA_ROOT,
          id: undefined,
          dataSize: TX_SIZE,
          weaveOffset: WEAVE_OFFSET,
        }),
      );

      const service = new ChunkRetrievalService({
        log,
        chunkSource,
        txBoundarySource,
      });

      const result = await service.retrieveChunk(ABSOLUTE_OFFSET);

      assert.equal(result.type, 'boundary_fetch');
      assert.equal(hasTxId(result), false);
      assert.equal(result.dataRoot, B64_DATA_ROOT);
      assert.equal(result.dataSize, TX_SIZE);
    });
  });
});
