/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { LRUCache } from 'lru-cache';
import axios from 'axios';
import { HyperBeamRootTxIndex } from './hyperbeam-root-tx-index.js';
import { createTestLogger } from '../../test/test-logger.js';

const log = createTestLogger({ suite: 'HyperBeamRootTxIndex' });

function createMockAxiosInstance(responseOrFn: any) {
  const getInstance =
    typeof responseOrFn === 'function' ? responseOrFn : () => responseOrFn;
  return {
    get: mock.fn((url: string) => getInstance(url)),
    defaults: { raxConfig: {} },
    interceptors: {
      request: { use: mock.fn(), eject: mock.fn() },
      response: { use: mock.fn(), eject: mock.fn() },
    },
  };
}

function createMockBoundarySource(result: any) {
  return {
    getTxBoundary: mock.fn(() => Promise.resolve(result)),
  };
}

function createMockOffsetSource(result: any) {
  return {
    getDataItemByOffset: mock.fn(() => Promise.resolve(result)),
  };
}

function createMockDataAttributesStore(attrs: any) {
  return {
    getDataAttributes: mock.fn(() => Promise.resolve(attrs)),
    setDataAttributes: mock.fn(() => Promise.resolve()),
  };
}

function createIndex(overrides: Record<string, any> = {}) {
  return new HyperBeamRootTxIndex({
    log,
    hyperbeamEndpoint: 'https://arweave.net',
    txBoundarySource: createMockBoundarySource(null),
    rateLimitBurstSize: 1000,
    rateLimitTokensPerInterval: 1000,
    rateLimitInterval: 'second' as const,
    ...overrides,
  });
}

describe('HyperBeamRootTxIndex', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  describe('constructor', () => {
    it('should implement DataItemRootIndex interface', () => {
      const index = createIndex();
      assert(typeof index.getRootTx === 'function');
    });
  });

  describe('getRootTx', () => {
    it('should resolve data item to root TX via HyperBEAM offset', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '355950809045177' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'data-root-123',
        dataSize: 1000000,
        weaveOffset: 355950810045176,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-data-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      assert.equal(
        result.rootDataOffset,
        355950809045177 - (355950810045176 - 1000000 + 1),
      );
      assert.equal(mockAxios.get.mock.calls.length, 1);
    });

    it('should handle string offset response', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '  12345  ' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'dr',
        dataSize: 1000,
        weaveOffset: 13344,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      assert.equal(result.rootDataOffset, 0);
    });

    it('should handle numeric offset response', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: 12345 }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'dr',
        dataSize: 100,
        weaveOffset: 12444,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      assert.equal(result.rootDataOffset, 0);
    });

    it('should return undefined for 404 from HyperBEAM', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.reject({ response: { status: 404 }, message: 'Not found' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('nonexistent-item');

      assert.equal(result, undefined);
    });

    it('should return undefined when boundary source returns null', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const txBoundarySource = createMockBoundarySource(null);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert.equal(result, undefined);
    });

    it('should return undefined when boundary has no TX ID', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: undefined,
        dataRoot: 'dr',
        dataSize: 100,
        weaveOffset: 12444,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert.equal(result, undefined);
    });

    it('should return undefined for non-numeric response', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: 'not-a-number' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-item');

      assert.equal(result, undefined);
    });

    it('should re-throw network errors for circuit breaker', async () => {
      const networkError = new Error('ECONNREFUSED');
      const mockAxios = createMockAxiosInstance(Promise.reject(networkError));
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      await assert.rejects(
        () => index.getRootTx('test-item'),
        (error: Error) => error.message === 'ECONNREFUSED',
      );
    });

    it('should return cached result on cache hit', async () => {
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const cachedResult = {
        rootTxId: 'cached-root-tx',
        rootDataOffset: 500,
      };
      cache.set('cached-item', cachedResult);

      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex({ cache });

      const result = await index.getRootTx('cached-item');

      assert.deepEqual(result, cachedResult);
      assert.equal(mockAxios.get.mock.calls.length, 0);
    });

    it('should return undefined when rate limit is exhausted', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const index = createIndex();

      (index as any)['limiter'].content = 0;

      const result = await index.getRootTx('rate-limited-item');

      assert.equal(result, undefined);
      assert.equal(mockAxios.get.mock.calls.length, 0);
    });

    it('should cache fully-enriched results after successful resolution', async () => {
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'dr',
        dataSize: 100,
        weaveOffset: 12444,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const ans104OffsetSource = createMockOffsetSource({
        itemOffset: 100,
        dataOffset: 200,
        itemSize: 500,
        dataSize: 400,
        contentType: 'application/json',
      });

      const index = createIndex({
        txBoundarySource,
        ans104OffsetSource,
        cache,
      });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      await index.getRootTx('test-item');

      const result = await index.getRootTx('test-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-abc');
      // Second call should be served from cache (no additional HTTP request)
      assert.equal(mockAxios.get.mock.calls.length, 1);
    });

    it('should not cache partial results', async () => {
      const cache = new LRUCache<string, any>({
        max: 100,
        ttl: 1000 * 60 * 5,
      });

      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '12345' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-abc',
        dataRoot: 'dr',
        dataSize: 100,
        weaveOffset: 12444,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      // No enrichment sources — result will be partial
      const index = createIndex({ txBoundarySource, cache });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      await index.getRootTx('test-item');

      // Cache should remain empty for partial results
      assert.equal(cache.has('test-item'), false);
    });
  });

  describe('offset-guided bundle parsing enrichment', () => {
    it('should enrich with complete result from offset source', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-bundle',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const ans104OffsetSource = createMockOffsetSource({
        itemOffset: 9500,
        dataOffset: 9999,
        itemSize: 2000,
        dataSize: 1501,
        contentType: 'application/json',
      });

      const index = createIndex({ txBoundarySource, ans104OffsetSource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-bundle-item');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-bundle');
      assert.equal(result.rootOffset, 9500);
      assert.equal(result.rootDataOffset, 9999);
      assert.equal(result.size, 2000);
      assert.equal(result.dataSize, 1501);
      assert.equal(result.contentType, 'application/json');

      // Verify offset source was called with correct args
      const call = ans104OffsetSource.getDataItemByOffset.mock.calls[0];
      assert.equal(call.arguments[0], 'test-bundle-item');
      assert.equal(call.arguments[1], 'root-tx-bundle');
      // relativeDataOffset = 50000 - (100000 - 60000 + 1) = 9999
      assert.equal(call.arguments[2], 9999);
    });

    it('should fall back to DB attrs when offset source returns null', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-fallback',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);
      const ans104OffsetSource = createMockOffsetSource(null);

      const dataAttributesStore = createMockDataAttributesStore({
        rootDataItemOffset: 9000,
        contentType: 'application/octet-stream',
        size: 500,
        itemSize: 600,
      });

      const index = createIndex({
        txBoundarySource,
        ans104OffsetSource,
        dataAttributesStore,
      });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-fallback');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-fallback');
      assert.equal(result.rootOffset, 9000);
      assert.equal(result.contentType, 'application/octet-stream');
      assert.equal(result.dataSize, 500);
      assert.equal(result.size, 600);
    });

    it('should fall back to DB attrs when offset source throws', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-error',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const ans104OffsetSource = {
        getDataItemByOffset: mock.fn(() =>
          Promise.reject(new Error('chunk unavailable')),
        ),
      };

      const dataAttributesStore = createMockDataAttributesStore({
        rootDataItemOffset: 9000,
        contentType: 'text/plain',
        size: 500,
        itemSize: 600,
      });

      const index = createIndex({
        txBoundarySource,
        ans104OffsetSource,
        dataAttributesStore,
      });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-error');

      assert(result !== undefined);
      assert.equal(result.rootOffset, 9000);
      assert.equal(result.contentType, 'text/plain');
    });

    it('should use DB attrs only when offset source not provided', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-nosource',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const dataAttributesStore = createMockDataAttributesStore({
        rootDataItemOffset: 9000,
        contentType: 'text/plain',
        size: 500,
        itemSize: 600,
      });

      const index = createIndex({
        txBoundarySource,
        ans104OffsetSource: undefined,
        dataAttributesStore,
      });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-nosource');

      assert(result !== undefined);
      assert.equal(result.rootOffset, 9000);
      assert.equal(result.contentType, 'text/plain');
    });

    it('should return incomplete result when both enrichments fail', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-incomplete',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const index = createIndex({ txBoundarySource });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-incomplete');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-incomplete');
      assert.equal(result.rootDataOffset, 50000 - (100000 - 60000 + 1));
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.contentType, undefined);
      assert.equal(result.size, undefined);
      assert.equal(result.dataSize, undefined);
    });
  });

  describe('DB attribute enrichment', () => {
    it('should enrich from data attributes when available', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-db',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const dataAttributesStore = createMockDataAttributesStore({
        rootDataItemOffset: 8500,
        contentType: 'video/mp4',
        size: 2000,
        itemSize: 2200,
      });

      const index = createIndex({ txBoundarySource, dataAttributesStore });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-db-enrich');

      assert(result !== undefined);
      assert.equal(result.rootOffset, 8500);
      assert.equal(result.contentType, 'video/mp4');
      assert.equal(result.dataSize, 2000);
      assert.equal(result.size, 2200);
    });

    it('should handle undefined data attributes gracefully', async () => {
      const mockAxios = createMockAxiosInstance(
        Promise.resolve({ data: '50000' }),
      );
      mock.method(axios, 'create', () => mockAxios);

      const boundary = {
        id: 'root-tx-noattrs',
        dataRoot: 'dr',
        dataSize: 60000,
        weaveOffset: 100000,
      };
      const txBoundarySource = createMockBoundarySource(boundary);

      const dataAttributesStore = createMockDataAttributesStore(undefined);

      const index = createIndex({ txBoundarySource, dataAttributesStore });
      (index as any)['limiter'].content = (index as any)['limiter'].bucketSize;

      const result = await index.getRootTx('test-noattrs');

      assert(result !== undefined);
      assert.equal(result.rootTxId, 'root-tx-noattrs');
      assert.equal(result.rootOffset, undefined);
      assert.equal(result.contentType, undefined);
    });
  });
});
