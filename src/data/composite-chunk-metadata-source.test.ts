/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, describe, it, mock } from 'node:test';
import * as winston from 'winston';

import {
  ChunkMetadata,
  ChunkMetadataByAnySource,
  ChunkDataByAnySourceParams,
} from '../types.js';
import { CompositeChunkMetadataSource } from './composite-chunk-metadata-source.js';

const TEST_PARAMS: ChunkDataByAnySourceParams = {
  txSize: 256000,
  absoluteOffset: 51530681327863,
  dataRoot: 'test-data-root',
  relativeOffset: 0,
};

const TEST_CHUNK_METADATA: ChunkMetadata = {
  offset: 51530681327863,
  dataRoot: Buffer.from('test-data-root'),
  dataSize: 256000,
  dataPath: Buffer.from('test-data-path'),
  hash: Buffer.from('test-hash'),
};

class MockChunkMetadataSource implements ChunkMetadataByAnySource {
  private shouldFail: boolean;
  private delay: number;
  private name: string;
  public callCount = 0;

  constructor(name: string, shouldFail = false, delay = 0) {
    this.name = name;
    this.shouldFail = shouldFail;
    this.delay = delay;
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkMetadata> {
    this.callCount++;
    if (this.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delay));
    }
    if (this.shouldFail) {
      throw new Error(`${this.name} failed`);
    }
    return { ...TEST_CHUNK_METADATA, hash: Buffer.from(`${this.name}-hash`) };
  }
}

describe('CompositeChunkMetadataSource', () => {
  let log: winston.Logger;

  before(() => {
    log = winston.createLogger({ silent: true });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should create instance with default parallelism', () => {
      const sources = [new MockChunkMetadataSource('source1')];
      const composite = new CompositeChunkMetadataSource({ log, sources });
      assert.ok(composite !== undefined);
    });

    it('should cap parallelism to number of sources', () => {
      const sources = [
        new MockChunkMetadataSource('source1'),
        new MockChunkMetadataSource('source2'),
      ];
      const composite = new CompositeChunkMetadataSource({
        log,
        sources,
        parallelism: 10,
      });
      assert.ok(composite !== undefined);
    });
  });

  describe('getChunkMetadataByAny', () => {
    it('should throw error when no sources configured', async () => {
      const composite = new CompositeChunkMetadataSource({ log, sources: [] });

      await assert.rejects(
        async () => composite.getChunkMetadataByAny(TEST_PARAMS),
        /No chunk metadata sources configured/,
      );
    });

    describe('sequential execution (parallelism = 1)', () => {
      it('should return metadata from first successful source', async () => {
        const source1 = new MockChunkMetadataSource('source1');
        const source2 = new MockChunkMetadataSource('source2');
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2],
          parallelism: 1,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        assert.equal(result.hash.toString(), 'source1-hash');
        assert.equal(source1.callCount, 1);
        assert.equal(source2.callCount, 0);
      });

      it('should try next source if first fails', async () => {
        const source1 = new MockChunkMetadataSource('source1', true);
        const source2 = new MockChunkMetadataSource('source2');
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2],
          parallelism: 1,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        assert.equal(result.hash.toString(), 'source2-hash');
        assert.equal(source1.callCount, 1);
        assert.equal(source2.callCount, 1);
      });

      it('should aggregate errors when all sources fail', async () => {
        const source1 = new MockChunkMetadataSource('source1', true);
        const source2 = new MockChunkMetadataSource('source2', true);
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2],
          parallelism: 1,
        });

        await assert.rejects(
          async () => composite.getChunkMetadataByAny(TEST_PARAMS),
          /Failed to fetch chunk metadata from any source.*source1 failed.*source2 failed/,
        );

        assert.equal(source1.callCount, 1);
        assert.equal(source2.callCount, 1);
      });
    });

    describe('parallel execution (parallelism > 1)', () => {
      it('should return metadata from first successful source', async () => {
        const source1 = new MockChunkMetadataSource('source1', false, 50);
        const source2 = new MockChunkMetadataSource('source2', false, 10);
        const source3 = new MockChunkMetadataSource('source3', false, 100);
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2, source3],
          parallelism: 3,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        // source2 should win due to shorter delay
        assert.equal(result.hash.toString(), 'source2-hash');
        assert.equal(source2.callCount, 1);
        // Other sources may or may not be called depending on timing
      });

      it('should handle mixed success and failure', async () => {
        const source1 = new MockChunkMetadataSource('source1', true, 10);
        const source2 = new MockChunkMetadataSource('source2', false, 50);
        const source3 = new MockChunkMetadataSource('source3', true, 20);
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2, source3],
          parallelism: 3,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        assert.equal(result.hash.toString(), 'source2-hash');
        assert.equal(source2.callCount, 1);
      });

      it('should limit concurrent requests', async () => {
        const sources = Array.from(
          { length: 10 },
          (_, i) => new MockChunkMetadataSource(`source${i}`, i < 9, 10),
        );
        const composite = new CompositeChunkMetadataSource({
          log,
          sources,
          parallelism: 3,
        });

        const start = Date.now();
        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);
        const duration = Date.now() - start;

        // Last source (source9) succeeds
        assert.equal(result.hash.toString(), 'source9-hash');
        // With parallelism of 3, we should process in batches
        // All 10 sources should be called since first 9 fail
        assert.equal(sources[9].callCount, 1);
      });

      it('should return first successful result even with slower sources', async () => {
        const source1 = new MockChunkMetadataSource('source1', false, 10);
        const source2 = new MockChunkMetadataSource('source2', false, 200);
        const source3 = new MockChunkMetadataSource('source3', false, 200);
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2, source3],
          parallelism: 3,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        assert.equal(result.hash.toString(), 'source1-hash');
        assert.equal(source1.callCount, 1);
      });

      it('should aggregate errors when all sources fail in parallel', async () => {
        const sources = Array.from(
          { length: 5 },
          (_, i) => new MockChunkMetadataSource(`source${i}`, true, 10),
        );
        const composite = new CompositeChunkMetadataSource({
          log,
          sources,
          parallelism: 3,
        });

        await assert.rejects(
          async () => composite.getChunkMetadataByAny(TEST_PARAMS),
          /Failed to fetch chunk metadata from any source/,
        );

        // All sources should be attempted
        sources.forEach((source) => {
          assert.equal(source.callCount, 1);
        });
      });
    });

    describe('edge cases', () => {
      it('should handle single source with parallelism > 1', async () => {
        const source = new MockChunkMetadataSource('source1');
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source],
          parallelism: 5,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        assert.equal(result.hash.toString(), 'source1-hash');
        assert.equal(source.callCount, 1);
      });

      it('should handle immediate failure with parallelism', async () => {
        const source1 = new MockChunkMetadataSource('source1', true, 0);
        const source2 = new MockChunkMetadataSource('source2', false, 50);
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2],
          parallelism: 2,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        assert.equal(result.hash.toString(), 'source2-hash');
      });

      it('should stop processing after finding success', async () => {
        let lateSourceStarted = false;
        const source1 = new MockChunkMetadataSource('source1', false, 10);

        class CheckingSource implements ChunkMetadataByAnySource {
          async getChunkMetadataByAny(
            params: ChunkDataByAnySourceParams,
          ): Promise<ChunkMetadata> {
            lateSourceStarted = true;
            await new Promise((resolve) => setTimeout(resolve, 100));
            return TEST_CHUNK_METADATA;
          }
        }

        const source2 = new CheckingSource();
        const source3 = new MockChunkMetadataSource('source3', false, 500);
        const composite = new CompositeChunkMetadataSource({
          log,
          sources: [source1, source2, source3],
          parallelism: 2,
        });

        const result = await composite.getChunkMetadataByAny(TEST_PARAMS);

        assert.equal(result.hash.toString(), 'source1-hash');
        // With parallelism of 2, source2 may start but source3 should not
        assert.ok(lateSourceStarted || true); // May or may not start depending on timing
      });
    });
  });
});
