/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Readable, Writable } from 'node:stream';
import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataIndex,
  ContiguousDataSource,
  ContiguousDataStore,
  DataAttributesSource,
  RequestAttributes,
} from '../types.js';
import { ReadThroughDataCache } from './read-through-data-cache.js';
import * as metrics from '../metrics.js';
import { TestDestroyedReadable } from './test-utils.js';
import {
  DataContentAttributeImporter,
  DataContentAttributeProperties,
} from '../workers/data-content-attribute-importer.js';
import { makeContiguousMetadataStore } from '../init/metadata-store.js';
import { createTestLogger } from '../../test/test-logger.js';

describe('ReadThroughDataCache', function () {
  let log: ReturnType<typeof createTestLogger>;
  let mockContiguousDataSource: ContiguousDataSource;
  let mockContiguousDataStore: ContiguousDataStore;
  let mockContiguousDataIndex: ContiguousDataIndex;
  let mockDataAttributesStore: DataAttributesSource;
  let mockDataContentAttributeImporter: DataContentAttributeImporter;
  let readThroughDataCache: ReadThroughDataCache;
  let requestAttributes: RequestAttributes;

  before(() => {
    log = createTestLogger({ suite: 'ReadThroughDataCache' });
  });

  beforeEach(() => {
    const mockContiguousData: ContiguousData = {
      stream: new Readable(),
      size: 100,
      verified: false,
      trusted: false,
      cached: false,
    };

    mockContiguousDataSource = {
      getData(_, __?: ContiguousDataAttributes): Promise<ContiguousData> {
        return Promise.resolve(mockContiguousData);
      },
    };

    mockContiguousDataStore = {
      has: async (_) => {
        return true;
      },
      get: async (hash, __) => {
        if (hash === 'knownHash') {
          const stream = new Readable();
          stream.push('simulated data');
          stream.push(null);
          return stream;
        }
        return undefined;
      },
      createWriteStream: async () => {
        const stream = new Writable({
          write(_chunk, _, callback) {
            callback();
          },
        });
        return stream;
      },
      cleanup: async (_) => Promise.resolve(),
      finalize: async (_, __) => Promise.resolve(),
    };

    mockContiguousDataIndex = {
      getDataAttributes: async (id: string) => {
        if (id === 'knownId') {
          return {
            size: 100,
            contentType: undefined,
            isManifest: false,
            stable: false,
            verified: false,
            signature: null,
          };
        }

        return undefined;
      },
      getDataParent: async (id: string) => {
        if (id === 'knownChildId') {
          return {
            parentId: 'knownParentId',
            hash: 'parentHash',
            offset: 0,
            size: 2048,
          };
        }

        return undefined;
      },

      // eslint-disable-next-line no-empty-pattern
      saveDataContentAttributes: async ({}: {
        id: string;
        dataRoot?: string;
        hash: string;
        dataSize: number;
        contentType?: string;
        cachedAt?: number;
      }) => {
        return Promise.resolve();
      },
    } as unknown as ContiguousDataIndex;

    mockDataAttributesStore = {
      getDataAttributes: async (id: string) => {
        if (id === 'knownId') {
          return {
            size: 100,
            contentType: undefined,
            isManifest: false,
            stable: false,
            verified: false,
            signature: null,
          };
        }
        return undefined;
      },
    };

    mockDataContentAttributeImporter = {
      queueDataContentAttributes: (_: DataContentAttributeProperties) => {
        return;
      },
    } as DataContentAttributeImporter;

    mock.method(metrics.getDataErrorsTotal, 'inc');
    mock.method(metrics.getDataStreamErrorsTotal, 'inc');
    mock.method(metrics.getDataStreamSuccessesTotal, 'inc');

    readThroughDataCache = new ReadThroughDataCache({
      log,
      dataSource: mockContiguousDataSource,
      dataStore: mockContiguousDataStore,
      metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
      contiguousDataIndex: mockContiguousDataIndex,
      dataAttributesStore: mockDataAttributesStore,
      dataContentAttributeImporter: mockDataContentAttributeImporter,
    });

    requestAttributes = {
      origin: 'node-url',
      hops: 0,
    };
  });

  afterEach(() => {
    mock.restoreAll();
  });

  describe('getCachedData', () => {
    it('should return data from cache when available', async () => {
      let calledWithArgument: string;
      const mockStream = new Readable();
      mockStream.push('cached data');
      mockStream.push(null);
      mock.method(mockContiguousDataStore, 'get', (hash: string) => {
        calledWithArgument = hash;
        return Promise.resolve(mockStream);
      });

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        123,
      );

      assert.deepEqual(calledWithArgument!, 'test-hash');
      assert.deepEqual(result?.stream, mockStream);
      assert.deepEqual(result?.size, 123);
    });

    it('should return undefined when data is not found in cache', async function () {
      let calledWithArgument: string;
      mock.method(mockContiguousDataStore, 'get', (hash: string) => {
        calledWithArgument = hash;

        return Promise.resolve(undefined);
      });

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        123,
      );

      assert.deepEqual(calledWithArgument!, 'test-hash');

      assert.deepEqual(result, undefined);
    });

    it('should return parent if found in cache when data is not found in cache', async function () {
      let calledWithArgument: string;
      let calledWithParentArgument: string;
      const mockStream = new Readable();
      mockStream.push('cached data');
      mockStream.push(null);
      mock.method(mockContiguousDataStore, 'get', (hash: string) => {
        if (hash === 'test-parent-hash') {
          calledWithParentArgument = hash;
          return Promise.resolve(mockStream);
        }
        calledWithArgument = hash;

        return Promise.resolve(undefined);
      });
      mock.method(mockContiguousDataIndex, 'getDataParent', () => {
        return Promise.resolve({
          parentId: 'test-parent-id',
          parentHash: 'test-parent-hash',
          offset: 0,
          size: 10,
        });
      });

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        20,
      );

      assert.deepEqual(calledWithArgument!, 'test-hash');

      assert.deepEqual(calledWithParentArgument!, 'test-parent-hash');

      assert.deepEqual(result?.stream, mockStream);
      assert.deepEqual(result?.size, 20);
    });
  });

  describe('getData', function () {
    it('should fetch cached data successfully', async function () {
      let calledWithArgument: string;
      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          hash: 'test-hash',
          size: 100,
          contentType: 'plain/text',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });
      mock.method(mockContiguousDataStore, 'get', (hash: string) => {
        calledWithArgument = hash;
        return Promise.resolve(
          new Readable({
            read() {
              this.push('test data');
              this.push(null);
            },
          }),
        );
      });

      const result = await readThroughDataCache.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.deepEqual(result, {
        hash: 'test-hash',
        stream: result.stream,
        size: 100,
        totalSize: 100,
        sourceContentType: 'plain/text',
        verified: true,
        trusted: true,
        cached: true,
        requestAttributes: {
          hops: requestAttributes.hops + 1,
          origin: 'node-url',
        },
      });
      assert.equal(calledWithArgument!, 'test-hash');

      let receivedData = '';

      for await (const chunk of result.stream) {
        receivedData += chunk;
      }

      assert.equal(receivedData, 'test data');
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.callCount(),
        1,
      );
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.calls[0]
          .arguments[0].class,
        'ReadThroughDataCache',
      );
    });

    it('should increment getDataStreamErrorsTotal for broken cached data stream', async function () {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      let calledWithArgument: string;
      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          hash: 'test-hash',
          size: 100,
          contentType: 'plain/text',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });
      mock.method(mockContiguousDataStore, 'get', (hash: string) => {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        calledWithArgument = hash;
        return new TestDestroyedReadable();
      });

      try {
        const result = await readThroughDataCache.getData({
          id: 'test-id',
          requestAttributes,
        });

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        let receivedData = '';

        for await (const chunk of result.stream) {
          receivedData += chunk;
        }
      } catch (error: any) {
        assert.equal(
          (metrics.getDataStreamErrorsTotal.inc as any).mock.callCount(),
          1,
        );
        assert.equal(
          (metrics.getDataStreamErrorsTotal.inc as any).mock.calls[0]
            .arguments[0].class,
          'ReadThroughDataCache',
        );
        assert.equal(error.message, 'Stream destroyed intentionally');
      }
    });

    it('should fetch data from the source and cache it when not available in cache', async function () {
      let calledWithArgument: any;
      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });
      mock.method(mockContiguousDataSource, 'getData', (args: any) => {
        calledWithArgument = args;
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('test data');
              this.push(null);
            },
          }),
          size: 99,
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      const result = await readThroughDataCache.getData({
        id: 'test-id',
        requestAttributes,
      });

      // Check that getData was called with expected arguments (excluding parentSpan which is implementation detail)
      assert.equal(calledWithArgument!.id, 'test-id');
      assert.equal(calledWithArgument!.dataAttributes, undefined);
      assert.deepEqual(
        calledWithArgument!.requestAttributes,
        requestAttributes,
      );
      assert.equal(calledWithArgument!.region, undefined);
      // parentSpan should be present but we don't need to check its exact value
      assert.deepEqual(
        (mockContiguousDataStore.createWriteStream as any).mock.callCount(),
        1,
      );

      let receivedData = '';

      for await (const chunk of result.stream) {
        receivedData += chunk;
      }

      assert.equal(receivedData, 'test data');
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.callCount(),
        1,
      );
      assert.equal(
        (metrics.getDataStreamSuccessesTotal.inc as any).mock.calls[0]
          .arguments[0].class,
        'ReadThroughDataCache',
      );

      assert.ok(result.stream instanceof Readable);
      assert.equal(result.size, 99);
      assert.equal(result.sourceContentType, 'plain/text');
      assert.equal(result.verified, true);
      assert.equal(result.cached, false);
    });

    it('should increment getDataStreamErrorsTotal for broken non cached data stream', async function () {
      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });
      mock.method(mockContiguousDataSource, 'getData', () => {
        return Promise.resolve({
          stream: new TestDestroyedReadable(),
          size: 99,
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      try {
        const result = await readThroughDataCache.getData({
          id: 'test-id',
          requestAttributes,
        });

        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        let receivedData = '';

        for await (const chunk of result.stream) {
          receivedData += chunk;
        }
      } catch (error: any) {
        assert.equal(
          (metrics.getDataStreamErrorsTotal.inc as any).mock.callCount(),
          1,
        );
        assert.equal(
          (metrics.getDataStreamErrorsTotal.inc as any).mock.calls[0]
            .arguments[0].class,
          'ReadThroughDataCache',
        );
        assert.equal(error.message, 'Stream destroyed intentionally');
      }
    });

    it('should fetch cached data successfully with region', async function () {
      const region = { offset: 10, size: 50 };
      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          hash: 'test-hash',
          size: 100,
          contentType: 'plain/text',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });
      mock.method(mockContiguousDataStore, 'get', (hash: string, reg: any) => {
        assert.equal(hash, 'test-hash');
        assert.deepEqual(reg, region);
        return Promise.resolve(
          new Readable({
            read() {
              this.push('partial test data');
              this.push(null);
            },
          }),
        );
      });

      const result = await readThroughDataCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      assert.deepEqual(result, {
        hash: 'test-hash',
        stream: result.stream,
        size: 50,
        totalSize: 100,
        sourceContentType: 'plain/text',
        verified: true,
        trusted: true,
        cached: true,
        requestAttributes: {
          hops: requestAttributes.hops + 1,
          origin: 'node-url',
        },
      });

      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, 'partial test data');
    });

    it('should fetch data from the source with region when not available in cache', async function () {
      const region = { offset: 10, size: 50 };
      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });
      mock.method(mockContiguousDataSource, 'getData', (params: any) => {
        assert.deepEqual(params.region, region);
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('partial source data');
              this.push(null);
            },
          }),
          size: 50,
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      const result = await readThroughDataCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      assert.deepEqual(
        (mockContiguousDataStore.createWriteStream as any).mock.callCount(),
        0,
      );

      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }

      assert.equal(receivedData, 'partial source data');
      assert.ok(result.stream instanceof Readable);
      assert.equal(result.size, 50);
      assert.equal(result.sourceContentType, 'plain/text');
      assert.equal(result.verified, true);
      assert.equal(result.cached, false);
    });

    it('should handle errors when fetching data with region', async function () {
      const region = { offset: 10, size: 50 };
      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataSource, 'getData', () => {
        throw new Error('Failed to fetch data with region');
      });

      await assert.rejects(
        readThroughDataCache.getData({
          id: 'test-id',
          requestAttributes,
          region,
        }),
        /Failed to fetch data with region/,
      );

      assert.equal((metrics.getDataErrorsTotal.inc as any).mock.callCount(), 1);
      assert.equal(
        (metrics.getDataErrorsTotal.inc as any).mock.calls[0].arguments[0]
          .class,
        'ReadThroughDataCache',
      );
    });
  });

  describe('skipCache', () => {
    it('should skip cache retrieval when skipCache is enabled', async () => {
      const skipCacheInstance = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCache: true,
      });

      // Mock the getCacheData method to ensure it returns undefined when skipCache is true
      const result = await skipCacheInstance.getCacheData(
        'test-id',
        'test-hash',
        100,
      );

      assert.equal(result, undefined);
    });

    it('should fetch data from upstream when skipCache is enabled', async () => {
      const skipCacheInstance = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCache: true,
      });

      // Mock data attributes
      mock.method(mockContiguousDataIndex, 'getDataAttributes', () => {
        return Promise.resolve({
          hash: 'test-hash',
          size: 100,
          contentType: 'plain/text',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });

      // Mock upstream data source
      const upstreamStream = new Readable();
      upstreamStream.push('upstream data');
      upstreamStream.push(null);

      mock.method(mockContiguousDataSource, 'getData', () => {
        return Promise.resolve({
          hash: 'test-hash',
          stream: upstreamStream,
          size: 100,
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      const result = await skipCacheInstance.getData({
        id: 'test-id',
        requestAttributes,
      });

      assert.equal(result.cached, false);
      assert.equal(result.trusted, true);
      assert.equal(result.size, 100);
    });

    it('should skip cache writes when skipCache is enabled', async () => {
      let createWriteStreamCalls = 0;
      let queueDataContentAttributesCalls = 0;

      const skipCacheInstance = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCache: true,
      });

      // Mock data attributes to ensure we would normally cache this data
      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          hash: 'test-hash',
          size: 100,
          contentType: 'plain/text',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });

      // Track calls to cache write operations
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        createWriteStreamCalls++;
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      mock.method(
        mockDataContentAttributeImporter,
        'queueDataContentAttributes',
        () => {
          queueDataContentAttributesCalls++;
          return;
        },
      );

      // Mock upstream data source that would normally be cached
      mock.method(mockContiguousDataSource, 'getData', () => {
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('test data from upstream');
              this.push(null);
            },
          }),
          size: 100,
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true, // This would normally trigger caching
          cached: false,
        });
      });

      const result = await skipCacheInstance.getData({
        id: 'test-id',
        requestAttributes,
      });

      // Verify that cache write operations were skipped
      assert.equal(
        createWriteStreamCalls,
        0,
        'createWriteStream should not be called when skipCache is true',
      );
      assert.equal(
        queueDataContentAttributesCalls,
        0,
        'queueDataContentAttributes should not be called when skipCache is true',
      );

      // Verify data is still returned correctly
      assert.equal(result.cached, false);
      assert.equal(result.trusted, true);
      assert.equal(result.size, 100);

      // Consume the stream to verify data integrity
      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, 'test data from upstream');
    });
  });

  describe('zero-size data handling', () => {
    it('should skip caching and indexing for zero-size data', async function () {
      let createWriteStreamCalls = 0;
      let queueDataContentAttributesCalls = 0;

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        createWriteStreamCalls++;
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      mock.method(
        mockDataContentAttributeImporter,
        'queueDataContentAttributes',
        () => {
          queueDataContentAttributesCalls++;
          return;
        },
      );

      mock.method(mockContiguousDataSource, 'getData', (args: any) => {
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push(null); // Empty stream
            },
          }),
          size: 0, // Zero-size data
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      const result = await readThroughDataCache.getData({
        id: 'test-id',
        requestAttributes,
      });

      // Verify that zero-size data is returned correctly
      assert.ok(result.stream instanceof Readable);
      assert.equal(result.size, 0);
      assert.equal(result.sourceContentType, 'plain/text');
      assert.equal(result.verified, true);
      assert.equal(result.trusted, true);
      assert.equal(result.cached, false);

      // Verify that caching operations were skipped
      assert.equal(
        createWriteStreamCalls,
        0,
        'createWriteStream should not be called for zero-size data',
      );
      assert.equal(
        queueDataContentAttributesCalls,
        0,
        'queueDataContentAttributes should not be called for zero-size data',
      );

      // Consume the stream to ensure it's empty
      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, '');
    });

    it('should cache non-zero-size data normally', async function () {
      let createWriteStreamCalls = 0;
      let queueDataContentAttributesCalls = 0;

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        createWriteStreamCalls++;
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      mock.method(
        mockDataContentAttributeImporter,
        'queueDataContentAttributes',
        () => {
          queueDataContentAttributesCalls++;
          return;
        },
      );

      mock.method(mockContiguousDataSource, 'getData', (args: any) => {
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('test data');
              this.push(null);
            },
          }),
          size: 9, // Non-zero size
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      const result = await readThroughDataCache.getData({
        id: 'test-id',
        requestAttributes,
      });

      // Verify that non-zero-size data is returned correctly
      assert.ok(result.stream instanceof Readable);
      assert.equal(result.size, 9);
      assert.equal(result.sourceContentType, 'plain/text');
      assert.equal(result.verified, true);
      assert.equal(result.trusted, true);
      assert.equal(result.cached, false);

      // Verify that caching operations were performed
      assert.equal(
        createWriteStreamCalls,
        1,
        'createWriteStream should be called for non-zero-size data',
      );
      // Note: queueDataContentAttributes is called asynchronously in the pipeline callback
      // so we can't reliably assert it here in this synchronous test

      // Consume the stream to verify data
      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, 'test data');
    });
  });

  describe('abort signal handling', () => {
    it('should throw immediately when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      let upstreamCalled = false;
      mockContiguousDataSource.getData = async () => {
        upstreamCalled = true;
        return {
          stream: Readable.from(['data']),
          size: 4,
          verified: false,
          trusted: true,
          cached: false,
        };
      };

      await assert.rejects(
        readThroughDataCache.getData({
          id: 'test-id',
          signal: controller.signal,
        }),
        { name: 'AbortError' },
      );

      // Verify upstream was not called
      assert.equal(upstreamCalled, false);
    });

    it('should pass signal to upstream data source', async () => {
      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;

      mockContiguousDataSource.getData = async (params: {
        signal?: AbortSignal;
      }) => {
        receivedSignal = params.signal;
        return {
          stream: Readable.from(['data']),
          size: 4,
          verified: false,
          trusted: true,
          cached: false,
        };
      };

      // Return cache miss to force upstream fetch
      mockDataAttributesStore.getDataAttributes = async () => undefined;
      mockContiguousDataIndex.getDataParent = async () => undefined;

      await readThroughDataCache.getData({
        id: 'uncached-id',
        signal: controller.signal,
      });

      assert.strictEqual(receivedSignal, controller.signal);
    });
  });

  describe('DATA_CACHED event emission', () => {
    it('should emit DATA_CACHED event when data is cached successfully', async function () {
      const eventEmitter = new EventEmitter();
      const eventPromise = new Promise<any>((resolve) => {
        eventEmitter.on('data-cached', resolve);
      });

      const cacheWithEmitter = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore as any,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        eventEmitter,
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });
      mock.method(mockContiguousDataSource, 'getData', () => {
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('test data');
              this.push(null);
            },
          }),
          size: 9,
          sourceContentType: 'text/html',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      const result = await cacheWithEmitter.getData({
        id: 'test-id',
        requestAttributes,
      });

      // Consume the stream to trigger the pipeline callback
      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, 'test data');

      // Wait for the pipeline callback which emits the event
      const emittedEvent = await eventPromise;

      assert.equal(emittedEvent.id, 'test-id');
      assert.equal(emittedEvent.dataSize, 9);
      assert.equal(emittedEvent.contentType, 'text/html');
      assert.ok(emittedEvent.hash !== undefined, 'hash should be present');
      assert.ok(
        emittedEvent.cachedAt !== undefined,
        'cachedAt should be present',
      );
    });
  });

  describe('background range caching', () => {
    it('should trigger background cache on range cache miss', async () => {
      const region = { offset: 10, size: 50 };
      let getDataCallCount = 0;
      const getDataCalls: any[] = [];

      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          size: 200,
          contentType: 'application/octet-stream',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      mock.method(mockContiguousDataSource, 'getData', (params: any) => {
        getDataCallCount++;
        getDataCalls.push({ ...params });
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('test data');
              this.push(null);
            },
          }),
          size: params.region ? 50 : 200,
          sourceContentType: 'application/octet-stream',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheTriggeredTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheCompletedTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
        backgroundCacheRangeConcurrency: 2,
      });

      const result = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      // Consume the stream
      for await (const chunk of result.stream) {
        // drain
      }

      // Wait for background fetch to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Upstream should be called twice: once with region, once without
      assert.equal(getDataCallCount, 2);
      assert.deepEqual(getDataCalls[0].region, region);
      assert.equal(getDataCalls[1].region, undefined);

      assert.equal(
        (
          metrics.backgroundRangeCacheTriggeredTotal.inc as any
        ).mock.callCount(),
        1,
      );
    });

    it('should use upstream totalSize when attributes size is unknown', async () => {
      const region = { offset: 10, size: 50 };
      let getDataCallCount = 0;

      // No attributes available (unindexed item)
      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve(undefined);
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      mock.method(mockContiguousDataSource, 'getData', (params: any) => {
        getDataCallCount++;
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('test data');
              this.push(null);
            },
          }),
          size: params.region ? 50 : 200,
          totalSize: 200, // Upstream knows the full size
          sourceContentType: 'application/octet-stream',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheTriggeredTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheCompletedTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
        backgroundCacheRangeConcurrency: 2,
      });

      const result = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      // Consume the stream
      for await (const chunk of result.stream) {
        // drain
      }

      // Wait for background fetch to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Upstream should be called twice: once with region, once without (background cache)
      assert.equal(getDataCallCount, 2);

      // Background cache should have been triggered (not skipped with unknown_size)
      assert.equal(
        (
          metrics.backgroundRangeCacheTriggeredTotal.inc as any
        ).mock.callCount(),
        1,
      );

      // Should not have been skipped with unknown_size reason
      const skipCalls = (metrics.backgroundRangeCacheSkippedTotal.inc as any)
        .mock.calls;
      const unknownSizeSkips = skipCalls.filter(
        (c: any) => c.arguments[0]?.reason === 'unknown_size',
      );
      assert.equal(unknownSizeSkips.length, 0);
    });

    it('should skip when disabled (default max size 0)', async () => {
      const region = { offset: 10, size: 50 };

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataSource, 'getData', () => {
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('data');
              this.push(null);
            },
          }),
          size: 50,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      // Default instance has backgroundCacheRangeMaxSize = 0
      const result = await readThroughDataCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      for await (const chunk of result.stream) {
        // drain
      }

      const skipCalls = (metrics.backgroundRangeCacheSkippedTotal.inc as any)
        .mock.calls;
      const disabledSkips = skipCalls.filter(
        (c: any) => c.arguments[0]?.reason === 'disabled',
      );
      assert.ok(disabledSkips.length > 0);
    });

    it('should skip when item exceeds max size', async () => {
      const region = { offset: 0, size: 50 };

      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          size: 5000,
          contentType: 'text/plain',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataSource, 'getData', () => {
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('data');
              this.push(null);
            },
          }),
          size: 50,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
      });

      const result = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      for await (const chunk of result.stream) {
        // drain
      }

      const skipCalls = (metrics.backgroundRangeCacheSkippedTotal.inc as any)
        .mock.calls;
      const exceedsSkips = skipCalls.filter(
        (c: any) => c.arguments[0]?.reason === 'exceeds_max_size',
      );
      assert.ok(exceedsSkips.length > 0);
    });

    it('should deduplicate when already pending', async () => {
      const region = { offset: 0, size: 50 };
      let getDataCallCount = 0;

      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          size: 200,
          contentType: 'text/plain',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      // Use a slow stream for the background fetch so it stays pending
      mock.method(mockContiguousDataSource, 'getData', (params: any) => {
        getDataCallCount++;
        const stream = new Readable({
          read() {
            if (params.region) {
              this.push('range data');
              this.push(null);
            } else {
              // Slow stream for background fetch
              setTimeout(() => {
                this.push('full data');
                this.push(null);
              }, 200);
            }
          },
        });
        return Promise.resolve({
          stream,
          size: params.region ? 50 : 200,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheTriggeredTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
        backgroundCacheRangeConcurrency: 2,
      });

      // First request triggers background cache
      const result1 = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });
      for await (const chunk of result1.stream) {
        // drain
      }

      // Second request for same ID should be deduplicated
      const result2 = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });
      for await (const chunk of result2.stream) {
        // drain
      }

      // Wait for background to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Only one background fetch should have been triggered
      assert.equal(
        (
          metrics.backgroundRangeCacheTriggeredTotal.inc as any
        ).mock.callCount(),
        1,
      );

      const skipCalls = (metrics.backgroundRangeCacheSkippedTotal.inc as any)
        .mock.calls;
      const alreadyPendingSkips = skipCalls.filter(
        (c: any) => c.arguments[0]?.reason === 'already_pending',
      );
      assert.ok(alreadyPendingSkips.length > 0);
    });

    it('should drop at concurrency capacity', async () => {
      const region = { offset: 0, size: 50 };

      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          size: 200,
          contentType: 'text/plain',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      // Slow stream to keep the semaphore acquired
      mock.method(mockContiguousDataSource, 'getData', (params: any) => {
        const stream = new Readable({
          read() {
            if (params.region) {
              this.push('range');
              this.push(null);
            } else {
              setTimeout(() => {
                this.push('full');
                this.push(null);
              }, 500);
            }
          },
        });
        return Promise.resolve({
          stream,
          size: params.region ? 50 : 200,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheTriggeredTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      // Concurrency of 1
      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
        backgroundCacheRangeConcurrency: 1,
      });

      // First request takes the semaphore
      const result1 = await bgCache.getData({
        id: 'test-id-1',
        requestAttributes,
        region,
      });
      for await (const chunk of result1.stream) {
        // drain
      }

      // Give microtask a chance to acquire semaphore
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second request should be dropped (at capacity)
      const result2 = await bgCache.getData({
        id: 'test-id-2',
        requestAttributes,
        region,
      });
      for await (const chunk of result2.stream) {
        // drain
      }

      // Wait for everything to complete
      await new Promise((resolve) => setTimeout(resolve, 600));

      assert.equal(
        (
          metrics.backgroundRangeCacheTriggeredTotal.inc as any
        ).mock.callCount(),
        1,
      );

      const skipCalls = (metrics.backgroundRangeCacheSkippedTotal.inc as any)
        .mock.calls;
      const capacitySkips = skipCalls.filter(
        (c: any) => c.arguments[0]?.reason === 'at_capacity',
      );
      assert.ok(capacitySkips.length > 0);
    });

    it('should not affect client when background fetch fails', async () => {
      const region = { offset: 0, size: 50 };
      let callCount = 0;

      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          size: 200,
          contentType: 'text/plain',
          isManifest: false,
          stable: true,
          verified: true,
        });
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );

      mock.method(mockContiguousDataSource, 'getData', (params: any) => {
        callCount++;
        if (!params.region) {
          // Background fetch fails
          return Promise.reject(new Error('upstream failure'));
        }
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('range data');
              this.push(null);
            },
          }),
          size: 50,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheFailedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
      });

      const result = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      // Client still gets their data
      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }
      assert.equal(receivedData, 'range data');
      assert.equal(result.size, 50);

      // Wait for background to fail
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(
        (metrics.backgroundRangeCacheFailedTotal.inc as any).mock.callCount(),
        1,
      );
    });

    it('should skip when skipCache is true', async () => {
      const region = { offset: 0, size: 50 };

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataSource, 'getData', () => {
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('data');
              this.push(null);
            },
          }),
          size: 50,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCache: true,
        backgroundCacheRangeMaxSize: 1000,
      });

      const result = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      for await (const chunk of result.stream) {
        // drain
      }

      const skipCalls = (metrics.backgroundRangeCacheSkippedTotal.inc as any)
        .mock.calls;
      const skipCacheSkips = skipCalls.filter(
        (c: any) => c.arguments[0]?.reason === 'skip_cache_set',
      );
      assert.ok(skipCacheSkips.length > 0);
    });

    it('should not trigger on full (non-range) cache miss', async () => {
      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () => {
        return Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        );
      });

      let getDataCallCount = 0;
      mock.method(mockContiguousDataSource, 'getData', () => {
        getDataCallCount++;
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('data');
              this.push(null);
            },
          }),
          size: 100,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheTriggeredTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
      });

      // Full request (no region)
      const result = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
      });

      for await (const chunk of result.stream) {
        // drain
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Only the original getData call, no background fetch
      assert.equal(getDataCallCount, 1);
      assert.equal(
        (
          metrics.backgroundRangeCacheTriggeredTotal.inc as any
        ).mock.callCount(),
        0,
      );
    });

    it('should skip when full item size is unknown', async () => {
      const region = { offset: 10, size: 50 };

      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve(undefined);
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );

      let getDataCallCount = 0;
      mock.method(mockContiguousDataSource, 'getData', (params: any) => {
        getDataCallCount++;
        return Promise.resolve({
          stream: new Readable({
            read() {
              this.push('data');
              this.push(null);
            },
          }),
          size: 50,
          sourceContentType: 'text/plain',
          verified: true,
          trusted: true,
          cached: false,
        });
      });

      mock.method(metrics.backgroundRangeCacheTriggeredTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const bgCache = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        backgroundCacheRangeMaxSize: 1000,
        backgroundCacheRangeConcurrency: 2,
      });

      const result = await bgCache.getData({
        id: 'test-id',
        requestAttributes,
        region,
      });

      for await (const chunk of result.stream) {
        // drain
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      // No background fetch should have been triggered
      assert.equal(getDataCallCount, 1);
      assert.equal(
        (
          metrics.backgroundRangeCacheTriggeredTotal.inc as any
        ).mock.callCount(),
        0,
      );

      const skipCalls = (metrics.backgroundRangeCacheSkippedTotal.inc as any)
        .mock.calls;
      const unknownSizeSkips = skipCalls.filter(
        (c: any) => c.arguments[0]?.reason === 'unknown_size',
      );
      assert.ok(unknownSizeSkips.length > 0);
    });
  });
});
