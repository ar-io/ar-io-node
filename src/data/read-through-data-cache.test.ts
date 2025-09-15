/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { Readable, Writable } from 'node:stream';
import * as winston from 'winston';
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

describe('ReadThroughDataCache', function () {
  let log: winston.Logger;
  let mockContiguousDataSource: ContiguousDataSource;
  let mockContiguousDataStore: ContiguousDataStore;
  let mockContiguousDataIndex: ContiguousDataIndex;
  let mockDataAttributesSource: DataAttributesSource;
  let mockDataContentAttributeImporter: DataContentAttributeImporter;
  let readThroughDataCache: ReadThroughDataCache;
  let requestAttributes: RequestAttributes;

  before(() => {
    log = winston.createLogger({ silent: true });
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

    mockDataAttributesSource = {
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
      dataAttributesSource: mockDataAttributesSource,
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
      mock.method(mockDataAttributesSource, 'getDataAttributes', () => {
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
      mock.method(mockDataAttributesSource, 'getDataAttributes', () => {
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
      mock.method(mockDataAttributesSource, 'getDataAttributes', () => {
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
        dataAttributesSource: mockDataAttributesSource,
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
        dataAttributesSource: mockDataAttributesSource,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCache: true,
      });

      // Mock data attributes to ensure we would normally cache this data
      mock.method(mockDataAttributesSource, 'getDataAttributes', () => {
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
});
