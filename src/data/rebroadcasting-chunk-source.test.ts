/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import { createTestLogger } from '../../test/test-logger.js';
import {
  RebroadcastingChunkSource,
  RebroadcastOptions,
} from './rebroadcasting-chunk-source.js';
import {
  BroadcastChunkResult,
  Chunk,
  ChunkBroadcaster,
  ChunkByAnySource,
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  JsonChunkPost,
} from '../types.js';

// Test constants
const TEST_DATA_ROOT = Buffer.from('test-data-root-32-bytes-padding!');
const TEST_DATA_ROOT_B64 = TEST_DATA_ROOT.toString('base64url');
const TEST_CHUNK_DATA = Buffer.from('test-chunk-data');
const TEST_DATA_PATH = Buffer.from('test-data-path-buffer');
const TEST_HASH = Buffer.from('test-hash-32-bytes-padding-here!');

const TEST_PARAMS: ChunkDataByAnySourceParams = {
  txSize: 1000,
  absoluteOffset: 12345,
  dataRoot: TEST_DATA_ROOT_B64,
  relativeOffset: 0,
};

const createTestChunk = (source?: string): Chunk => ({
  data_root: TEST_DATA_ROOT,
  chunk: TEST_CHUNK_DATA,
  data_size: 1000,
  data_path: TEST_DATA_PATH,
  offset: 0,
  hash: TEST_HASH,
  source,
});

// Use high token count to avoid rate limiting in most tests
const DEFAULT_OPTIONS: RebroadcastOptions = {
  sources: ['legacy-s3'],
  rateLimitTokens: 10000, // High limit to avoid rate limiting
  rateLimitInterval: 'second',
  maxConcurrent: 10,
  dedupTtlSeconds: 3600,
  minSuccessCount: 1,
};

class MockChunkSource implements ChunkByAnySource, ChunkDataByAnySource {
  public callCount = 0;
  public lastParams: ChunkDataByAnySourceParams | null = null;
  private chunk: Chunk;

  constructor(chunk: Chunk) {
    this.chunk = chunk;
  }

  async getChunkByAny(params: ChunkDataByAnySourceParams): Promise<Chunk> {
    this.callCount++;
    this.lastParams = params;
    return this.chunk;
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    return {
      chunk: this.chunk.chunk,
      data_path: this.chunk.data_path,
      source: this.chunk.source,
    };
  }

  setChunk(chunk: Chunk): void {
    this.chunk = chunk;
  }
}

class MockChunkBroadcaster implements ChunkBroadcaster {
  public callCount = 0;
  public lastChunk: JsonChunkPost | null = null;
  public shouldFail = false;
  public result: BroadcastChunkResult = {
    successCount: 1,
    failureCount: 0,
    results: [
      { success: true, statusCode: 200, canceled: false, timedOut: false },
    ],
  };
  private resolveNextBroadcast: (() => void) | null = null;
  private broadcastPromise: Promise<void> | null = null;

  async broadcastChunk({
    chunk,
  }: {
    chunk: JsonChunkPost;
    originAndHopsHeaders: Record<string, string | undefined>;
    chunkPostMinSuccessCount: number;
  }): Promise<BroadcastChunkResult> {
    // Wait for external signal if one is set up
    if (this.broadcastPromise) {
      await this.broadcastPromise;
    }
    this.callCount++;
    this.lastChunk = chunk;
    if (this.shouldFail) {
      throw new Error('Broadcast failed');
    }
    return this.result;
  }

  // Set up a barrier that blocks broadcast until signalBroadcast is called
  setupBroadcastBarrier(): void {
    this.broadcastPromise = new Promise((resolve) => {
      this.resolveNextBroadcast = resolve;
    });
  }

  // Release the broadcast barrier
  signalBroadcast(): void {
    if (this.resolveNextBroadcast) {
      this.resolveNextBroadcast();
      this.resolveNextBroadcast = null;
      this.broadcastPromise = null;
    }
  }

  reset(): void {
    this.callCount = 0;
    this.lastChunk = null;
    this.shouldFail = false;
    this.resolveNextBroadcast = null;
    this.broadcastPromise = null;
    this.result = {
      successCount: 1,
      failureCount: 0,
      results: [
        { success: true, statusCode: 200, canceled: false, timedOut: false },
      ],
    };
  }
}

let log: ReturnType<typeof createTestLogger>;
let mockChunkSource: MockChunkSource;
let mockBroadcaster: MockChunkBroadcaster;

before(() => {
  log = createTestLogger({ suite: 'RebroadcastingChunkSource' });
});

beforeEach(() => {
  mockChunkSource = new MockChunkSource(createTestChunk('legacy-s3'));
  mockBroadcaster = new MockChunkBroadcaster();
});

afterEach(() => {
  mock.restoreAll();
  mockBroadcaster.reset();
});

describe('RebroadcastingChunkSource', () => {
  describe('getChunkByAny', () => {
    it('should delegate to wrapped source and return chunk immediately', async () => {
      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      const result = await wrapper.getChunkByAny(TEST_PARAMS);

      assert.equal(mockChunkSource.callCount, 1);
      assert.deepEqual(mockChunkSource.lastParams, TEST_PARAMS);
      assert.deepEqual(result.data_root, TEST_DATA_ROOT);
      assert.deepEqual(result.chunk, TEST_CHUNK_DATA);
    });

    it('should trigger rebroadcast for configured sources', async () => {
      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();

      assert.equal(mockBroadcaster.callCount, 1);
      assert.ok(mockBroadcaster.lastChunk);
      assert.equal(mockBroadcaster.lastChunk.data_root, TEST_DATA_ROOT_B64);
    });

    it('should skip rebroadcast for cache source', async () => {
      mockChunkSource.setChunk(createTestChunk('cache'));

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();

      assert.equal(mockBroadcaster.callCount, 0);
    });

    it('should skip rebroadcast for unconfigured sources', async () => {
      mockChunkSource.setChunk(createTestChunk('ar-io-network'));

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS, // Only 'legacy-s3' configured
      });

      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();

      assert.equal(mockBroadcaster.callCount, 0);
    });

    it('should skip rebroadcast for chunks with undefined source', async () => {
      mockChunkSource.setChunk(createTestChunk(undefined));

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();

      assert.equal(mockBroadcaster.callCount, 0);
    });

    it('should not block chunk fetch when broadcast fails', async () => {
      mockBroadcaster.shouldFail = true;

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      const result = await wrapper.getChunkByAny(TEST_PARAMS);

      // Chunk fetch should succeed despite broadcast failure
      assert.deepEqual(result.data_root, TEST_DATA_ROOT);
      assert.deepEqual(result.chunk, TEST_CHUNK_DATA);

      await wrapper.awaitPendingRebroadcasts();

      // Broadcast was attempted (even though it failed)
      assert.equal(mockBroadcaster.callCount, 1);
    });

    it('should propagate chunk fetch errors', async () => {
      const failingSource: ChunkByAnySource & ChunkDataByAnySource = {
        async getChunkByAny(): Promise<Chunk> {
          throw new Error('Fetch failed');
        },
        async getChunkDataByAny(): Promise<ChunkData> {
          throw new Error('Fetch failed');
        },
      };

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: failingSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      await assert.rejects(() => wrapper.getChunkByAny(TEST_PARAMS), {
        message: 'Fetch failed',
      });

      // No broadcast should be attempted
      assert.equal(mockBroadcaster.callCount, 0);
    });
  });

  describe('deduplication cache', () => {
    it('should not rebroadcast same chunk twice within TTL', async () => {
      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      // First fetch - should trigger broadcast
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 1);

      // Second fetch with same params - should skip due to dedup cache
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 1); // Still 1, not 2
    });

    it('should rebroadcast different chunks', async () => {
      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      // First chunk
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 1);

      // Different chunk (different relativeOffset)
      await wrapper.getChunkByAny({ ...TEST_PARAMS, relativeOffset: 100 });
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 2);
    });

    it('should not cache on broadcast failure', async () => {
      mockBroadcaster.shouldFail = true;

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      // First attempt - fails
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 1);

      // Reset broadcaster to succeed
      mockBroadcaster.shouldFail = false;

      // Second attempt - should try again since first failed
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 2);
    });

    it('should not cache when success count below threshold', async () => {
      mockBroadcaster.result = {
        successCount: 0,
        failureCount: 1,
        results: [
          { success: false, statusCode: 500, canceled: false, timedOut: false },
        ],
      };

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: { ...DEFAULT_OPTIONS, minSuccessCount: 1 },
      });

      // First attempt - below threshold
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 1);

      // Fix broadcaster result
      mockBroadcaster.result = {
        successCount: 1,
        failureCount: 0,
        results: [
          { success: true, statusCode: 200, canceled: false, timedOut: false },
        ],
      };

      // Second attempt - should try again since first didn't meet threshold
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 2);
    });
  });

  describe('rate limiting', () => {
    it('should rate limit rebroadcasts', async () => {
      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: {
          ...DEFAULT_OPTIONS,
          rateLimitTokens: 2, // Only allow 2 per interval
          rateLimitInterval: 'minute',
        },
      });

      // Trigger multiple fetches with different chunks
      for (let i = 0; i < 5; i++) {
        await wrapper.getChunkByAny({ ...TEST_PARAMS, relativeOffset: i });
      }

      await wrapper.awaitPendingRebroadcasts();

      // Only 2 should have been broadcast due to rate limit
      assert.equal(mockBroadcaster.callCount, 2);
    });
  });

  describe('concurrency limiting', () => {
    it('should limit concurrent broadcasts', async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;
      let totalBroadcasts = 0;
      const barrierResolvers: (() => void)[] = [];

      const controlledBroadcaster: ChunkBroadcaster = {
        async broadcastChunk(): Promise<BroadcastChunkResult> {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);

          // Wait for external signal to complete
          await new Promise<void>((resolve) => {
            barrierResolvers.push(resolve);
          });

          concurrentCount--;
          totalBroadcasts++;
          return {
            successCount: 1,
            failureCount: 0,
            results: [
              {
                success: true,
                statusCode: 200,
                canceled: false,
                timedOut: false,
              },
            ],
          };
        },
      };

      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: controlledBroadcaster,
        options: {
          ...DEFAULT_OPTIONS,
          maxConcurrent: 2,
        },
      });

      // Trigger 5 concurrent fetches
      for (let i = 0; i < 5; i++) {
        await wrapper.getChunkByAny({ ...TEST_PARAMS, relativeOffset: i });
      }

      // Wait for broadcasts to queue up
      while (barrierResolvers.length < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // At this point, 2 broadcasts should be in progress (max concurrent)
      assert.equal(concurrentCount, 2);
      assert.equal(maxConcurrent, 2);

      // Release all waiting broadcasts one by one
      while (barrierResolvers.length > 0) {
        barrierResolvers.shift()!();
        // Let event loop process
        await new Promise((resolve) => setImmediate(resolve));
      }

      await wrapper.awaitPendingRebroadcasts();

      // All 5 should have completed
      assert.equal(totalBroadcasts, 5);
      // Max concurrent should never exceed the limit
      assert.ok(
        maxConcurrent <= 2,
        `Max concurrent was ${maxConcurrent}, expected <= 2`,
      );
    });
  });

  describe('chunk to JsonChunkPost conversion', () => {
    it('should correctly convert chunk to JsonChunkPost format', async () => {
      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: DEFAULT_OPTIONS,
      });

      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();

      assert.ok(mockBroadcaster.lastChunk);
      assert.equal(
        mockBroadcaster.lastChunk.data_root,
        TEST_DATA_ROOT.toString('base64url'),
      );
      assert.equal(
        mockBroadcaster.lastChunk.chunk,
        TEST_CHUNK_DATA.toString('base64url'),
      );
      assert.equal(
        mockBroadcaster.lastChunk.data_path,
        TEST_DATA_PATH.toString('base64url'),
      );
      assert.equal(mockBroadcaster.lastChunk.data_size, '1000');
      assert.equal(mockBroadcaster.lastChunk.offset, '0');
    });
  });

  describe('multiple configured sources', () => {
    it('should rebroadcast from any configured source', async () => {
      const wrapper = new RebroadcastingChunkSource({
        log,
        chunkSource: mockChunkSource,
        chunkBroadcaster: mockBroadcaster,
        options: {
          ...DEFAULT_OPTIONS,
          sources: ['legacy-s3', 'ar-io-network'],
        },
      });

      // Test legacy-s3
      mockChunkSource.setChunk(createTestChunk('legacy-s3'));
      await wrapper.getChunkByAny(TEST_PARAMS);
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 1);

      // Test ar-io-network (different offset to avoid dedup)
      mockChunkSource.setChunk(createTestChunk('ar-io-network'));
      await wrapper.getChunkByAny({ ...TEST_PARAMS, relativeOffset: 100 });
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 2);

      // Test arweave-network (not configured, should skip)
      mockChunkSource.setChunk(createTestChunk('arweave-network'));
      await wrapper.getChunkByAny({ ...TEST_PARAMS, relativeOffset: 200 });
      await wrapper.awaitPendingRebroadcasts();
      assert.equal(mockBroadcaster.callCount, 2); // Still 2
    });
  });
});
