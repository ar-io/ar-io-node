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
import { Semaphore } from '../lib/semaphore.js';

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
      delete: async (_) => Promise.resolve(),
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

    it('should return undefined when dataSize is undefined', async () => {
      const mockStream = new Readable();
      mockStream.push('cached data');
      mockStream.push(null);
      mock.method(mockContiguousDataStore, 'get', () => {
        return Promise.resolve(mockStream);
      });

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        undefined,
      );

      assert.deepEqual(result, undefined);
    });

    it('should return undefined when dataSize is zero', async () => {
      const mockStream = new Readable();
      mockStream.push(null);
      mock.method(mockContiguousDataStore, 'get', () => {
        return Promise.resolve(mockStream);
      });

      const result = await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        0,
      );

      assert.deepEqual(result, undefined);
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

    it('should preserve caller region.size through parent-data resolution (PE-9098)', async function () {
      // Regression: when an item resolves via its parent's cached blob, the
      // recursive getCacheData call must keep the caller's requested slice
      // size, not replace it with the child's full data size. The previous
      // behavior asked FsDataStore to open a 1.55 GB window when the
      // attribute-fetcher only wanted 512 bytes of signature data.
      let regionPassedToDataStore: { offset: number; size: number } | undefined;
      const mockStream = new Readable();
      mockStream.push('cached data');
      mockStream.push(null);
      mock.method(
        mockContiguousDataStore,
        'get',
        (hash: string, region?: { offset: number; size: number }) => {
          if (hash === 'test-parent-hash') {
            regionPassedToDataStore = region;
            return Promise.resolve(mockStream);
          }
          return Promise.resolve(undefined);
        },
      );
      mock.method(mockContiguousDataIndex, 'getDataParent', () => {
        return Promise.resolve({
          parentId: 'test-parent-id',
          parentHash: 'test-parent-hash',
          offset: 2766,
          size: 1545359648, // child's full data size (1.55 GB)
        });
      });

      await readThroughDataCache.getCacheData(
        'test-id',
        'test-hash',
        1545359648,
        { offset: 1690, size: 512 },
      );

      assert.deepEqual(regionPassedToDataStore, {
        offset: 2766 + 1690,
        size: 512, // caller's requested slice — NOT 1545359648
      });
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

  describe('skipCacheWrites', () => {
    // The distinction that matters operationally: skipCacheWrites stops a full
    // cache volume from growing, but must NOT stop it being served. SKIP_DATA_CACHE
    // does both, which also starves the index-driven evictor of the rows it needs
    // to reclaim anything.
    it('should still serve cache reads when only writes are skipped', async () => {
      const writeSkippedInstance = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCacheWrites: true,
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(Readable.from([Buffer.from('cached')])),
      );

      const result = await writeSkippedInstance.getCacheData(
        'test-id',
        'test-hash',
        100,
      );

      assert.notEqual(result, undefined);
    });

    it('should not write to the cache on an upstream miss', async () => {
      // The point of the flag. getCacheData() alone cannot show this: it never
      // consults skipCacheWrites, so a read-only assertion passes even if the
      // write path is still running.
      const writeSkippedInstance = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataAttributesStore: mockDataAttributesStore,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCacheWrites: true,
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataStore, 'createWriteStream', () =>
        Promise.resolve(
          new Writable({
            write(_, __, callback) {
              callback();
            },
          }),
        ),
      );
      mock.method(mockContiguousDataSource, 'getData', () =>
        Promise.resolve({
          stream: new Readable({
            read() {
              this.push('test data');
              this.push(null);
            },
          }),
          size: 9,
          sourceContentType: 'plain/text',
          verified: true,
          trusted: true,
          cached: false,
        }),
      );

      const result = await writeSkippedInstance.getData({ id: 'test-id' });

      let receivedData = '';
      for await (const chunk of result.stream) {
        receivedData += chunk;
      }

      // Upstream data still reaches the caller...
      assert.equal(receivedData, 'test data');
      // ...but nothing was staged to disk.
      assert.equal(
        (mockContiguousDataStore.createWriteStream as any).mock.callCount(),
        0,
      );
    });

    it('should skip reads as well when the full skipCache is enabled', async () => {
      const fullSkipInstance = new ReadThroughDataCache({
        log,
        dataSource: mockContiguousDataSource,
        dataStore: mockContiguousDataStore,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        skipCache: true,
      });

      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(Readable.from([Buffer.from('cached')])),
      );

      const result = await fullSkipInstance.getCacheData(
        'test-id',
        'test-hash',
        100,
      );

      assert.equal(result, undefined);
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

    it('should skip when dataSize is NaN', async () => {
      const region = { offset: 10, size: 50 };

      // Return attributes with NaN size
      mock.method(mockDataAttributesStore, 'getDataAttributes', () => {
        return Promise.resolve({
          size: NaN,
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

  describe('constructor validation', () => {
    it('should reject NaN backgroundCacheRangeMaxSize', () => {
      assert.throws(
        () =>
          new ReadThroughDataCache({
            log,
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
            contiguousDataIndex: mockContiguousDataIndex,
            dataAttributesStore: mockDataAttributesStore,
            dataContentAttributeImporter: mockDataContentAttributeImporter,
            backgroundCacheRangeMaxSize: NaN,
          }),
        /backgroundCacheRangeMaxSize must be a non-negative finite number/,
      );
    });

    it('should reject negative backgroundCacheRangeMaxSize', () => {
      assert.throws(
        () =>
          new ReadThroughDataCache({
            log,
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
            contiguousDataIndex: mockContiguousDataIndex,
            dataAttributesStore: mockDataAttributesStore,
            dataContentAttributeImporter: mockDataContentAttributeImporter,
            backgroundCacheRangeMaxSize: -1,
          }),
        /backgroundCacheRangeMaxSize must be a non-negative finite number/,
      );
    });

    it('should reject NaN backgroundCacheRangeConcurrency', () => {
      assert.throws(
        () =>
          new ReadThroughDataCache({
            log,
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
            contiguousDataIndex: mockContiguousDataIndex,
            dataAttributesStore: mockDataAttributesStore,
            dataContentAttributeImporter: mockDataContentAttributeImporter,
            backgroundCacheRangeMaxSize: 1000,
            backgroundCacheRangeConcurrency: NaN,
          }),
        /backgroundCacheRangeConcurrency must be a positive finite number/,
      );
    });

    it('should reject zero backgroundCacheRangeConcurrency', () => {
      assert.throws(
        () =>
          new ReadThroughDataCache({
            log,
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
            contiguousDataIndex: mockContiguousDataIndex,
            dataAttributesStore: mockDataAttributesStore,
            dataContentAttributeImporter: mockDataContentAttributeImporter,
            backgroundCacheRangeMaxSize: 1000,
            backgroundCacheRangeConcurrency: 0,
          }),
        /backgroundCacheRangeConcurrency must be a positive finite number/,
      );
    });
  });

  describe('acceptContentType lazy poison eviction (PE-9099)', () => {
    it('evicts the on-disk blob and falls through when stored content-type fails the predicate', async () => {
      // Cache holds a poisoned text/html entry (the production scenario:
      // 1134-byte bundlr.network parking page cached as bundle bytes).
      // Caller asks for bundle bytes via acceptContentType predicate.
      // Expect: blob is deleted, request falls through to upstream.
      mock.method(mockDataAttributesStore, 'getDataAttributes', () =>
        Promise.resolve({
          hash: 'poisoned-hash',
          size: 1134,
          contentType: 'text/html; charset=utf-8',
          isManifest: false,
          stable: false,
          verified: false,
          signature: null,
        }),
      );

      let deletedHash: string | undefined;
      mock.method(mockContiguousDataStore, 'delete', (hash: string) => {
        deletedHash = hash;
        return Promise.resolve();
      });

      let upstreamCalled = false;
      mock.method(mockContiguousDataSource, 'getData', () => {
        upstreamCalled = true;
        return Promise.resolve({
          stream: Readable.from([Buffer.alloc(64, 'A')]),
          size: 64,
          verified: false,
          trusted: true,
          cached: false,
          sourceContentType: 'application/octet-stream',
        });
      });
      mock.method(mockContiguousDataStore, 'createWriteStream', () =>
        Promise.resolve(
          new Writable({
            write(_chunk, _enc, cb) {
              cb();
            },
          }),
        ),
      );

      const result = await readThroughDataCache.getData({
        id: 'poisoned-id',
        requestAttributes,
        acceptContentType: (ct) =>
          ct === undefined || ct.startsWith('application/octet-stream'),
      });

      assert.equal(
        deletedHash,
        'poisoned-hash',
        'poisoned blob should have been deleted by hash',
      );
      assert.equal(
        upstreamCalled,
        true,
        'upstream should have been called after eviction (treat as cache miss)',
      );
      assert.equal(
        result.cached,
        false,
        'returned data should not be from cache',
      );

      // Drain
      for await (const _ of result.stream) {
        // discard
      }
    });

    it('does NOT evict when no predicate is supplied (back-compat)', async () => {
      mock.method(mockDataAttributesStore, 'getDataAttributes', () =>
        Promise.resolve({
          hash: 'html-hash',
          size: 1134,
          contentType: 'text/html; charset=utf-8',
          isManifest: false,
          stable: false,
          verified: false,
          signature: null,
        }),
      );

      let deleteCalled = false;
      mock.method(mockContiguousDataStore, 'delete', () => {
        deleteCalled = true;
        return Promise.resolve();
      });
      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(
          new Readable({
            read() {
              this.push(Buffer.alloc(1134, 0x3c));
              this.push(null);
            },
          }),
        ),
      );

      const result = await readThroughDataCache.getData({
        id: 'html-id',
        requestAttributes,
        // no acceptContentType
      });

      assert.equal(
        deleteCalled,
        false,
        'no predicate → no eviction (back-compat)',
      );
      assert.equal(result.cached, true);
      assert.equal(result.sourceContentType, 'text/html; charset=utf-8');

      // Drain
      for await (const _ of result.stream) {
        // discard
      }
    });

    it('does NOT evict when stored content-type passes the predicate', async () => {
      mock.method(mockDataAttributesStore, 'getDataAttributes', () =>
        Promise.resolve({
          hash: 'clean-hash',
          size: 64,
          contentType: 'application/octet-stream',
          isManifest: false,
          stable: false,
          verified: false,
          signature: null,
        }),
      );

      let deleteCalled = false;
      mock.method(mockContiguousDataStore, 'delete', () => {
        deleteCalled = true;
        return Promise.resolve();
      });
      mock.method(mockContiguousDataStore, 'get', () =>
        Promise.resolve(
          new Readable({
            read() {
              this.push(Buffer.alloc(64));
              this.push(null);
            },
          }),
        ),
      );

      const result = await readThroughDataCache.getData({
        id: 'clean-id',
        requestAttributes,
        acceptContentType: (ct) =>
          ct === undefined || ct.startsWith('application/octet-stream'),
      });

      assert.equal(
        deleteCalled,
        false,
        'acceptable content-type → no eviction',
      );
      assert.equal(result.cached, true);

      // Drain
      for await (const _ of result.stream) {
        // discard
      }
    });

    it('forwards acceptContentType to the upstream data source on cache miss', async () => {
      mock.method(mockDataAttributesStore, 'getDataAttributes', () =>
        Promise.resolve(undefined),
      );
      mock.method(mockContiguousDataIndex, 'getDataParent', () =>
        Promise.resolve(undefined),
      );

      let upstreamReceivedPredicate:
        | ((ct: string | undefined) => boolean)
        | undefined;
      mock.method(mockContiguousDataSource, 'getData', (args: any) => {
        upstreamReceivedPredicate = args.acceptContentType;
        return Promise.resolve({
          stream: Readable.from([Buffer.alloc(64, 'A')]),
          size: 64,
          verified: false,
          trusted: true,
          cached: false,
        });
      });
      mock.method(mockContiguousDataStore, 'createWriteStream', () =>
        Promise.resolve(
          new Writable({
            write(_chunk, _enc, cb) {
              cb();
            },
          }),
        ),
      );

      const myPredicate = (ct: string | undefined) =>
        ct === undefined || ct.startsWith('application/octet-stream');

      const result = await readThroughDataCache.getData({
        id: 'uncached-id',
        requestAttributes,
        acceptContentType: myPredicate,
      });

      assert.strictEqual(
        upstreamReceivedPredicate,
        myPredicate,
        'predicate must flow through to upstream getData() so the upstream source can reject too',
      );

      // Drain
      for await (const _ of result.stream) {
        // discard
      }
    });
  });

  describe('foreground fetch coalescing', () => {
    // A content-addressed store that actually remembers what was finalized, so
    // a follower woken by the leader can really be served from the cache.
    function makeStatefulStore() {
      const finalized = new Map<string, string>();
      const counters = {
        createWriteStream: 0,
        cleanup: 0,
        finalize: 0,
        get: 0,
      };

      const store: ContiguousDataStore = {
        has: async () => false,
        get: async (hash: string) => {
          counters.get++;
          const content = finalized.get(hash);
          if (content === undefined) {
            return undefined;
          }
          return new Readable({
            read() {
              this.push(content);
              this.push(null);
            },
          });
        },
        createWriteStream: async () => {
          counters.createWriteStream++;
          const chunks: Buffer[] = [];
          const stream: any = new Writable({
            write(chunk, _, callback) {
              chunks.push(Buffer.from(chunk));
              callback();
            },
          });
          stream.__chunks = chunks;
          return stream;
        },
        cleanup: async () => {
          counters.cleanup++;
        },
        finalize: async (stream: any, hash: string) => {
          counters.finalize++;
          finalized.set(hash, Buffer.concat(stream.__chunks).toString());
        },
        delete: async (hash: string) => {
          finalized.delete(hash);
        },
      } as unknown as ContiguousDataStore;

      return { store, finalized, counters };
    }

    // Mirrors the real attributes store closely enough that a follower's
    // re-read finds the hash the leader just wrote.
    function makeStatefulAttributesStore() {
      const attributes = new Map<string, any>();
      return {
        attributes,
        store: {
          getDataAttributes: async (id: string) => attributes.get(id),
          setDataAttributes: async (id: string, update: any) => {
            attributes.set(id, { ...(attributes.get(id) ?? {}), ...update });
          },
        } as any,
      };
    }

    function makeCache(overrides: any = {}) {
      return new ReadThroughDataCache({
        log,
        metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
        contiguousDataIndex: mockContiguousDataIndex,
        dataContentAttributeImporter: mockDataContentAttributeImporter,
        ...overrides,
      });
    }

    it('runs one upstream fetch and one staging file for N concurrent requests', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'concurrent payload';
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          // Stay in flight long enough for every follower to arrive.
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            sourceContentType: 'application/octet-stream',
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
      });

      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          cache
            .getData({ id: 'stampede-id', requestAttributes })
            .then(async (result) => {
              let received = '';
              for await (const chunk of result.stream) {
                received += chunk;
              }
              return received;
            }),
        ),
      );

      // The regression: one upstream fetch, one staging file -- not 50 of each.
      assert.equal(upstreamCalls, 1);
      assert.equal(counters.createWriteStream, 1);
      assert.equal(counters.finalize, 1);
      // No follower orphaned a staging file on the way through.
      assert.equal(counters.cleanup, 0);
      // Every caller still got the full object.
      assert.equal(results.length, 50);
      for (const received of results) {
        assert.equal(received, payload);
      }
      // The fix CONVERTS this load rather than removing it: the leader writes
      // once, and every waiter then opens its own read of the finalized blob.
      // That is the same shape as N concurrent requests for an already-cached
      // object -- the gateway's ordinary steady state -- and vastly cheaper
      // than N concurrent multi-GB writes, but it is a real fan-out and is
      // asserted here so a future change cannot silently make it worse.
      assert.equal(counters.get, 49);
    });

    it('counts coalesced requests in foregroundCacheSkippedTotal', async () => {
      mock.method(metrics.foregroundCacheSkippedTotal, 'inc');
      mock.method(metrics.foregroundCacheCoalescedOutcomeTotal, 'inc');

      const { store } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'metric payload';

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
      });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          cache
            .getData({ id: 'metric-id', requestAttributes })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
            }),
        ),
      );

      const skips = (metrics.foregroundCacheSkippedTotal.inc as any).mock.calls
        .map((c: any) => c.arguments[0]?.reason)
        .filter((r: string) => r === 'already_pending');
      assert.equal(skips.length, 2);

      const outcomes = (
        metrics.foregroundCacheCoalescedOutcomeTotal.inc as any
      ).mock.calls.map((c: any) => c.arguments[0]?.outcome);
      assert.equal(outcomes.length, 2);
      for (const outcome of outcomes) {
        assert.equal(outcome, 'cache_hit');
      }
    });

    it('does not cancel the shared fetch or leak a staging file when a follower aborts', async () => {
      const { store, counters, finalized } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'survives follower abort';
      let upstreamCalls = 0;
      let upstreamDestroyed = false;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          await new Promise((resolve) => setTimeout(resolve, 40));
          const stream = new Readable({
            read() {
              setTimeout(() => {
                this.push(payload);
                this.push(null);
              }, 40);
            },
          });
          stream.once('close', () => {
            if (!stream.readableEnded) {
              upstreamDestroyed = true;
            }
          });
          return {
            stream,
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
      });

      const leader = cache
        .getData({ id: 'abort-id', requestAttributes })
        .then(async (result) => {
          let received = '';
          for await (const chunk of result.stream) {
            received += chunk;
          }
          return received;
        });

      // Let the leader claim the key before the follower attaches.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const controller = new AbortController();
      const follower = cache.getData({
        id: 'abort-id',
        requestAttributes,
        signal: controller.signal,
      });
      const followerSettled = follower.then(
        () => 'resolved',
        (error: any) => error.name,
      );

      // Abort while the leader is still downloading.
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      assert.equal(await followerSettled, 'AbortError');

      // The leader is unaffected: it finishes, finalizes, and its staging file
      // is neither cleaned up nor duplicated.
      assert.equal(await leader, payload);
      assert.equal(upstreamCalls, 1);
      assert.equal(upstreamDestroyed, false);
      assert.equal(counters.createWriteStream, 1);
      assert.equal(counters.finalize, 1);
      assert.equal(counters.cleanup, 0);
      assert.equal(finalized.size, 1);
    });

    it('falls back to its own fetch when the leader fails', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'second attempt';
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          if (upstreamCalls === 1) {
            await new Promise((resolve) => setTimeout(resolve, 40));
            throw new Error('upstream exploded');
          }
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
      });

      const leader = cache
        .getData({ id: 'failing-id', requestAttributes })
        .then(
          () => 'resolved',
          (error: any) => error.message,
        );

      await new Promise((resolve) => setTimeout(resolve, 10));

      const follower = cache
        .getData({ id: 'failing-id', requestAttributes })
        .then(async (result) => {
          let received = '';
          for await (const chunk of result.stream) {
            received += chunk;
          }
          return received;
        });

      assert.equal(await leader, 'upstream exploded');
      // The follower is not stranded -- it refetches and succeeds.
      assert.equal(await follower, payload);
      assert.equal(upstreamCalls, 2);
      assert.equal(counters.createWriteStream, 1);
    });

    it('does not coalesce range requests', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return {
            stream: new Readable({
              read() {
                this.push('range');
                this.push(null);
              },
            }),
            size: 5,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
      });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          cache
            .getData({
              id: 'range-id',
              requestAttributes,
              region: { offset: 0, size: 5 },
            })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
            }),
        ),
      );

      // Range requests cache nothing, so there is no finalized blob to serve a
      // follower from -- they must each fetch. No staging files either.
      assert.equal(upstreamCalls, 3);
      assert.equal(counters.createWriteStream, 0);
    });

    // A stream source that stays in flight long enough for followers to arrive.
    function makeCountingSource(payload: string, counter: { calls: number }) {
      const source: ContiguousDataSource = {
        getData: async () => {
          counter.calls++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            sourceContentType: 'application/octet-stream',
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };
      return source;
    }

    it('does not coalesce an item known to be below the coalesce floor', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore, attributes } =
        makeStatefulAttributesStore();
      const counter = { calls: 0 };

      // Known small: the floor applies and each caller fetches for itself.
      attributes.set('small-id', { size: 1024 });

      const cache = makeCache({
        dataSource: makeCountingSource('small payload', counter),
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheCoalesceMinSize: 1048576,
      });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          cache
            .getData({ id: 'small-id', requestAttributes })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
            }),
        ),
      );

      // Pre-coalescing behavior is preserved exactly for small items.
      assert.equal(counter.calls, 3);
      assert.equal(counters.createWriteStream, 3);
    });

    it('coalesces an item at or above the coalesce floor', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore, attributes } =
        makeStatefulAttributesStore();
      const counter = { calls: 0 };

      attributes.set('large-id', { size: 1048576 });

      const cache = makeCache({
        dataSource: makeCountingSource('large payload', counter),
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheCoalesceMinSize: 1048576,
      });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          cache
            .getData({ id: 'large-id', requestAttributes })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
            }),
        ),
      );

      // The floor is inclusive: size === floor still coalesces.
      assert.equal(counter.calls, 1);
      assert.equal(counters.createWriteStream, 1);
    });

    it('coalesces an item of unknown size even with a floor set', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const counter = { calls: 0 };

      // No attributes seeded: size is unknown at the point coalescing is
      // decided. Treating it as eligible keeps stampede protection at least as
      // strong as it is with no floor configured.
      const cache = makeCache({
        dataSource: makeCountingSource('unknown size payload', counter),
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheCoalesceMinSize: 1048576,
      });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          cache
            .getData({ id: 'unknown-id', requestAttributes })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
            }),
        ),
      );

      assert.equal(counter.calls, 1);
      assert.equal(counters.createWriteStream, 1);
    });

    it('coalesces every size when the floor is left at its default of 0', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore, attributes } =
        makeStatefulAttributesStore();
      const counter = { calls: 0 };

      attributes.set('tiny-id', { size: 1 });

      // No foregroundCacheCoalesceMinSize override: the default must leave
      // coalescing behavior identical to a build without the floor.
      const cache = makeCache({
        dataSource: makeCountingSource('tiny payload', counter),
        dataStore: store,
        dataAttributesStore: attributesStore,
      });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          cache
            .getData({ id: 'tiny-id', requestAttributes })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
            }),
        ),
      );

      assert.equal(counter.calls, 1);
      assert.equal(counters.createWriteStream, 1);
    });

    it('counts floor exemptions in foregroundCacheSkippedTotal', async () => {
      mock.method(metrics.foregroundCacheSkippedTotal, 'inc');
      const { store } = makeStatefulStore();
      const { store: attributesStore, attributes } =
        makeStatefulAttributesStore();
      const counter = { calls: 0 };

      attributes.set('metric-id', { size: 512 });

      const cache = makeCache({
        dataSource: makeCountingSource('metric payload', counter),
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheCoalesceMinSize: 1048576,
      });

      const result = await cache.getData({
        id: 'metric-id',
        requestAttributes,
      });
      for await (const _ of result.stream) {
        // drain
      }

      const reasons = (
        metrics.foregroundCacheSkippedTotal.inc as any
      ).mock.calls.map((call: any) => call.arguments[0]?.reason);
      assert.ok(reasons.includes('below_coalesce_floor'));
    });

    it('rejects a negative foregroundCacheCoalesceMinSize', () => {
      assert.throws(
        () => makeCache({ foregroundCacheCoalesceMinSize: -1 }),
        /foregroundCacheCoalesceMinSize must be a non-negative finite number/,
      );
    });

    it('re-elects a new leader when the first one fails, instead of every waiter refetching', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'second leader payload';
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          const attempt = upstreamCalls;
          // Stay in flight long enough for the other callers to attach.
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (attempt === 1) {
            throw new Error('leader blew up');
          }
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            sourceContentType: 'application/octet-stream',
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          cache
            .getData({ id: 'reelect-id', requestAttributes })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
              return 'ok';
            }),
        ),
      );

      // One failed leader, then exactly one re-elected leader that the
      // remaining waiters shared. Without re-election every waiter released by
      // the failure would have fetched for itself: 1 + 3 = 4 upstream calls.
      assert.equal(upstreamCalls, 2);
      // Only one staging file: the first leader threw before streaming began,
      // so it never opened one. Re-election does not multiply staging files.
      assert.equal(counters.createWriteStream, 1);

      // The leader's own caller sees the failure; the waiters are served.
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      assert.equal(fulfilled, 3);
    });

    it('does not re-elect when the leader succeeded but declined to cache', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'uncacheable payload';
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            sourceContentType: 'application/octet-stream',
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      // Every write is declined by the size cap, so a re-elected leader would
      // be declined identically -- waiters must go straight to their own fetch
      // rather than burning an attempt to learn that.
      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheMaxSize: 1,
      });

      await Promise.all(
        Array.from({ length: 3 }, () =>
          cache
            .getData({ id: 'uncacheable-id', requestAttributes })
            .then(async (result) => {
              for await (const _ of result.stream) {
                // drain
              }
            }),
        ),
      );

      assert.equal(upstreamCalls, 3);
      assert.equal(counters.createWriteStream, 0);
    });

    it('stops re-electing once the attempt budget is spent', async () => {
      const { store } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      let upstreamCalls = 0;

      // Every leader fails, so the budget is what stops the chain.
      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new Error('always fails');
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheCoalesceMaxAttempts: 2,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          cache.getData({ id: 'always-fails-id', requestAttributes }),
        ),
      );

      // All four surface the failure rather than hanging, and the chain
      // terminates: nobody waits forever on a succession of dead leaders.
      assert.equal(results.length, 4);
      assert.ok(results.every((r) => r.status === 'rejected'));
      assert.ok(upstreamCalls >= 2);
      assert.ok(upstreamCalls <= 4);
    });

    it('rejects a foregroundCacheCoalesceMaxAttempts below 1', () => {
      assert.throws(
        () => makeCache({ foregroundCacheCoalesceMaxAttempts: 0 }),
        /foregroundCacheCoalesceMaxAttempts must be an integer >= 1/,
      );
    });

    it('serves the data but skips the cache write above foregroundCacheMaxSize', async () => {
      mock.method(metrics.foregroundCacheSkippedTotal, 'inc');
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'oversized payload';

      const dataSource: ContiguousDataSource = {
        getData: async () => ({
          stream: new Readable({
            read() {
              this.push(payload);
              this.push(null);
            },
          }),
          size: payload.length,
          verified: true,
          trusted: true,
          cached: false,
        }),
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheMaxSize: payload.length - 1,
      });

      const result = await cache.getData({
        id: 'oversized-id',
        requestAttributes,
      });
      let received = '';
      for await (const chunk of result.stream) {
        received += chunk;
      }

      assert.equal(received, payload);
      assert.equal(counters.createWriteStream, 0);
      const reasons = (
        metrics.foregroundCacheSkippedTotal.inc as any
      ).mock.calls
        .map((c: any) => c.arguments[0]?.reason)
        .filter((r: string) => r === 'exceeds_max_size');
      assert.equal(reasons.length, 1);
    });

    it('serves the data but skips the cache write at foregroundCacheConcurrency', async () => {
      mock.method(metrics.foregroundCacheSkippedTotal, 'inc');
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'bounded';

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            stream: new Readable({
              read() {
                setTimeout(() => {
                  this.push(payload);
                  this.push(null);
                }, 30);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheConcurrency: 1,
      });

      // Two DISTINCT ids, so coalescing does not apply -- only the semaphore.
      const received = await Promise.all(
        ['bounded-a', 'bounded-b'].map((id) =>
          cache.getData({ id, requestAttributes }).then(async (result) => {
            let out = '';
            for await (const chunk of result.stream) {
              out += chunk;
            }
            return out;
          }),
        ),
      );

      // Both callers are served; only one staging file was opened.
      assert.deepEqual(received, [payload, payload]);
      assert.equal(counters.createWriteStream, 1);
      const reasons = (
        metrics.foregroundCacheSkippedTotal.inc as any
      ).mock.calls
        .map((c: any) => c.arguments[0]?.reason)
        .filter((r: string) => r === 'at_capacity');
      assert.equal(reasons.length, 1);
    });

    it('releases the concurrency permit after a fetch completes', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'sequential';

      const dataSource: ContiguousDataSource = {
        getData: async () => ({
          stream: new Readable({
            read() {
              this.push(payload);
              this.push(null);
            },
          }),
          size: payload.length,
          verified: true,
          trusted: true,
          cached: false,
        }),
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheConcurrency: 1,
      });

      // Sequential fetches of distinct ids must each get a permit; if the
      // permit leaked, the second would be skipped at capacity.
      for (const id of ['seq-a', 'seq-b', 'seq-c']) {
        const result = await cache.getData({ id, requestAttributes });
        for await (const _ of result.stream) {
          // drain
        }
      }

      assert.equal(counters.createWriteStream, 3);
      assert.equal(counters.finalize, 3);
    });

    it('does not trigger a background range cache while a foreground fetch of the same ID is in flight', async () => {
      mock.method(metrics.backgroundRangeCacheTriggeredTotal, 'inc');
      mock.method(metrics.backgroundRangeCacheSkippedTotal, 'inc');

      const { store } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'full object';

      mock.method(attributesStore, 'getDataAttributes', async () => ({
        size: payload.length,
        contentType: 'text/plain',
        isManifest: false,
        stable: true,
        verified: true,
      }));

      const dataSource: ContiguousDataSource = {
        getData: async (params: any) => {
          if (params.region) {
            return {
              stream: new Readable({
                read() {
                  this.push('rng');
                  this.push(null);
                },
              }),
              size: 3,
              verified: true,
              trusted: true,
              cached: false,
            };
          }
          // Slow full fetch so it is still in flight when the range request
          // lands.
          await new Promise((resolve) => setTimeout(resolve, 80));
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        backgroundCacheRangeMaxSize: 10000,
        backgroundCacheRangeConcurrency: 1,
      });

      const foreground = cache
        .getData({ id: 'bg-overlap-id', requestAttributes })
        .then(async (result) => {
          for await (const _ of result.stream) {
            // drain
          }
        });

      await new Promise((resolve) => setTimeout(resolve, 20));

      const ranged = await cache.getData({
        id: 'bg-overlap-id',
        requestAttributes,
        region: { offset: 0, size: 3 },
      });
      for await (const _ of ranged.stream) {
        // drain
      }

      await foreground;

      // The foreground fetch is already caching the whole object, so the
      // background trigger must not fire and must not hold its permit.
      assert.equal(
        (
          metrics.backgroundRangeCacheTriggeredTotal.inc as any
        ).mock.callCount(),
        0,
      );
      const skips = (
        metrics.backgroundRangeCacheSkippedTotal.inc as any
      ).mock.calls
        .map((c: any) => c.arguments[0]?.reason)
        .filter((r: string) => r === 'already_pending');
      assert.equal(skips.length, 1);
    });

    it('releases the in-flight entry when the leader is aborted mid-download', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'after abort';
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async ({ signal }: any) => {
          upstreamCalls++;
          const stream = new Readable({ read() {} });
          if (upstreamCalls === 1) {
            // Mirror a real source: the caller's abort tears down the stream
            // with an AbortError, which reaches the pipeline callback.
            signal?.addEventListener('abort', () => {
              const abortError: any = new Error('Aborted');
              abortError.name = 'AbortError';
              stream.destroy(abortError);
            });
            return {
              stream,
              size: payload.length,
              verified: true,
              trusted: true,
              cached: false,
            };
          }
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        // Long enough that a leaked entry would park the second request well
        // past this test's own timeout rather than quietly passing.
        foregroundCacheCoalesceTimeoutMs: 60000,
      });

      const controller = new AbortController();
      const leader = cache.getData({
        id: 'aborted-leader-id',
        requestAttributes,
        signal: controller.signal,
      });
      const leaderSettled = leader.then(
        (result) => {
          result.stream.on('error', () => undefined);
          return 'resolved';
        },
        (error: any) => error.name,
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await leaderSettled;
      // Let the pipeline callback run its abort teardown.
      await new Promise((resolve) => setTimeout(resolve, 30));

      // Must not inherit the aborted leader's in-flight entry.
      const started = Date.now();
      const result = await cache.getData({
        id: 'aborted-leader-id',
        requestAttributes,
      });
      let received = '';
      for await (const chunk of result.stream) {
        received += chunk;
      }

      assert.equal(received, payload);
      assert.equal(upstreamCalls, 2);
      // Served promptly rather than after the coalesce timeout.
      assert.ok(
        Date.now() - started < 5000,
        'second request waited on a leaked in-flight entry',
      );
      assert.equal(counters.finalize, 1);
    });

    it('reclaims the concurrency permit from a stalled write', async () => {
      mock.method(metrics.foregroundCacheStalledWritesTotal, 'inc');
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'after the stall';
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          if (upstreamCalls === 1) {
            // Produces no bytes and never ends: the pipeline callback that
            // would normally return the permit never fires.
            return {
              stream: new Readable({ read() {} }),
              size: payload.length,
              verified: true,
              trusted: true,
              cached: false,
            };
          }
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheConcurrency: 1,
        foregroundCacheCoalesceTimeoutMs: 40,
      });

      const stalled = cache.getData({ id: 'stalled-id', requestAttributes });
      stalled.then(
        (result) => result.stream.on('error', () => undefined),
        () => undefined,
      );

      // Wait past the stall bound so the permit is reclaimed.
      await new Promise((resolve) => setTimeout(resolve, 80));

      // A different ID must still be able to acquire the single permit.
      const result = await cache.getData({
        id: 'after-stall-id',
        requestAttributes,
      });
      let received = '';
      for await (const chunk of result.stream) {
        received += chunk;
      }

      assert.equal(received, payload);
      assert.equal(
        (metrics.foregroundCacheStalledWritesTotal.inc as any).mock.callCount(),
        1,
      );
      // Two staging files: the stalled one, and the second write that only
      // succeeds because the permit came back.
      assert.equal(counters.createWriteStream, 2);
      assert.equal(counters.finalize, 1);
    });

    it('keeps its permit while a slow write is still making progress', async () => {
      mock.method(metrics.foregroundCacheStalledWritesTotal, 'inc');
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          let sent = 0;
          return {
            stream: new Readable({
              read() {
                // Drip a byte at a time, each well inside the stall bound, for
                // longer in total than that bound.
                setTimeout(() => {
                  if (sent < 8) {
                    sent++;
                    this.push('x');
                  } else {
                    this.push(null);
                  }
                }, 20);
              },
            }),
            size: 8,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheConcurrency: 1,
        foregroundCacheCoalesceTimeoutMs: 60,
      });

      const result = await cache.getData({ id: 'slow-id', requestAttributes });
      let received = '';
      for await (const chunk of result.stream) {
        received += chunk;
      }

      assert.equal(received, 'xxxxxxxx');
      // Live-but-slow is not stalled: the permit was never reclaimed early.
      assert.equal(
        (metrics.foregroundCacheStalledWritesTotal.inc as any).mock.callCount(),
        0,
      );
      assert.equal(counters.finalize, 1);
    });

    it('shares one concurrency budget when a semaphore is injected', async () => {
      mock.method(metrics.foregroundCacheSkippedTotal, 'inc');
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'shared';

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            stream: new Readable({
              read() {
                setTimeout(() => {
                  this.push(payload);
                  this.push(null);
                }, 30);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const shared = new Semaphore(1);
      const cacheA = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheSemaphore: shared,
      });
      const cacheB = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheSemaphore: shared,
      });

      const received = await Promise.all([
        cacheA.getData({ id: 'shared-a', requestAttributes }),
        cacheB.getData({ id: 'shared-b', requestAttributes }),
      ]).then((results) =>
        Promise.all(
          results.map(async (result) => {
            let out = '';
            for await (const chunk of result.stream) {
              out += chunk;
            }
            return out;
          }),
        ),
      );

      // Two separate cache instances, one budget: only one staging file.
      assert.deepEqual(received, [payload, payload]);
      assert.equal(counters.createWriteStream, 1);
      const reasons = (
        metrics.foregroundCacheSkippedTotal.inc as any
      ).mock.calls
        .map((c: any) => c.arguments[0]?.reason)
        .filter((r: string) => r === 'at_capacity');
      assert.equal(reasons.length, 1);
    });

    it('does not park later requests forever when the leader wedges', async () => {
      const { store, counters } = makeStatefulStore();
      const { store: attributesStore } = makeStatefulAttributesStore();
      const payload = 'eventually';
      let upstreamCalls = 0;

      const dataSource: ContiguousDataSource = {
        getData: async () => {
          upstreamCalls++;
          if (upstreamCalls === 1) {
            // A wedged stream: never ends, never errors. The leader's pipeline
            // callback never fires, so its in-flight entry is never settled.
            return {
              stream: new Readable({ read() {} }),
              size: payload.length,
              verified: true,
              trusted: true,
              cached: false,
            };
          }
          return {
            stream: new Readable({
              read() {
                this.push(payload);
                this.push(null);
              },
            }),
            size: payload.length,
            verified: true,
            trusted: true,
            cached: false,
          };
        },
      };

      const cache = makeCache({
        dataSource,
        dataStore: store,
        dataAttributesStore: attributesStore,
        foregroundCacheCoalesceTimeoutMs: 50,
      });

      // Leader wedges. Do not await it -- it never completes.
      const wedged = cache.getData({ id: 'wedged-id', requestAttributes });
      wedged.then(
        (result) => result.stream.on('error', () => undefined),
        () => undefined,
      );

      await new Promise((resolve) => setTimeout(resolve, 20));

      // A later request must not inherit the wedge.
      const follower = await cache.getData({
        id: 'wedged-id',
        requestAttributes,
      });
      let received = '';
      for await (const chunk of follower.stream) {
        received += chunk;
      }

      assert.equal(received, payload);
      assert.equal(upstreamCalls, 2);
      // The leader still holds its own staging file; the follower opened one
      // of its own rather than waiting on a fetch that will never finish.
      assert.equal(counters.createWriteStream, 2);
      assert.equal(counters.finalize, 1);
    });

    it('rejects invalid foreground cache options', () => {
      assert.throws(
        () =>
          makeCache({
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            dataAttributesStore: mockDataAttributesStore,
            foregroundCacheMaxSize: NaN,
          }),
        /foregroundCacheMaxSize must be a non-negative finite number/,
      );

      assert.throws(
        () =>
          makeCache({
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            dataAttributesStore: mockDataAttributesStore,
            foregroundCacheConcurrency: -1,
          }),
        /foregroundCacheConcurrency must be a non-negative integer/,
      );

      assert.throws(
        () =>
          makeCache({
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            dataAttributesStore: mockDataAttributesStore,
            foregroundCacheConcurrency: 1.5,
          }),
        /foregroundCacheConcurrency must be a non-negative integer/,
      );

      assert.throws(
        () =>
          makeCache({
            dataSource: mockContiguousDataSource,
            dataStore: mockContiguousDataStore,
            dataAttributesStore: mockDataAttributesStore,
            foregroundCacheCoalesceTimeoutMs: -1,
          }),
        /foregroundCacheCoalesceTimeoutMs must be a non-negative finite number/,
      );
    });
  });
});

describe('ReadThroughDataCache short-read rejection', () => {
  const log = createTestLogger({ silent: true } as any);

  // Local stand-ins: the suite-wide mocks are scoped to the outer describe's
  // beforeEach and are not visible here.
  const dataIndex = {
    getDataAttributes: async () => undefined,
    getDataParent: async () => undefined,
    saveDataContentAttributes: async () => undefined,
    clearDataHash: async () => undefined,
    setDataAttributes: async () => undefined,
  } as any;
  const attributeImporter = {
    queueDataContentAttributes: () => undefined,
  } as any;

  // Records what actually reached durable storage, so a test can assert the
  // difference between "finalized" and "cleaned up" rather than inspecting
  // log output.
  function makeStore() {
    const finalized = new Map<string, string>();
    const counters = { finalize: 0, cleanup: 0 };
    const store = {
      has: async () => false,
      get: async () => undefined,
      createWriteStream: async () => {
        const chunks: Buffer[] = [];
        const stream: any = new Writable({
          write(chunk, _, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        });
        stream.__chunks = chunks;
        return stream;
      },
      cleanup: async () => {
        counters.cleanup++;
      },
      finalize: async (stream: any, hash: string) => {
        counters.finalize++;
        finalized.set(hash, Buffer.concat(stream.__chunks).toString());
      },
      delete: async () => undefined,
    } as unknown as ContiguousDataStore;
    return { store, finalized, counters };
  }

  // `payload` is what upstream sends AND what it declares as its size — the
  // whole point of the bug being fixed is that a truncating peer reports a
  // Content-Length consistent with its own truncated body.
  function makeSource(payload: string): ContiguousDataSource {
    return {
      getData: async () => ({
        stream: new Readable({
          read() {
            this.push(payload);
            this.push(null);
          },
        }),
        size: payload.length,
        verified: false,
        trusted: true,
        cached: false,
      }),
    } as unknown as ContiguousDataSource;
  }

  function makeCache(attributes: any, store: ContiguousDataStore) {
    return new ReadThroughDataCache({
      log,
      dataSource: makeSource('R'),
      dataStore: store,
      metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
      contiguousDataIndex: dataIndex,
      dataContentAttributeImporter: attributeImporter,
      dataAttributesStore: {
        getDataAttributes: async () =>
          attributes instanceof Error ? Promise.reject(attributes) : attributes,
        setDataAttributes: async () => undefined,
      } as any,
    });
  }

  async function drain(result: any) {
    try {
      for await (const _ of result.stream) {
        // discard
      }
    } catch {
      // discard
    }
    // let the stream 'end' handler finish its async cache decision
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('refuses to cache a 1-byte body when the item is indexed as 24 MB', async () => {
    // The real DwObkWEd… case: a RIFF header byte cached as the whole file.
    const { store, counters, finalized } = makeStore();
    // Real attribute values from the DwObkWEd… row: header is
    // 2759 - 1628 = 1131, so the payload is 24,105,348 — exactly the size the
    // file's RIFF header declares.
    const cache = makeCache(
      {
        itemSize: 24106479,
        rootDataItemOffset: 1628,
        rootDataOffset: 2759,
      },
      store,
    );

    await drain(await cache.getData({ id: 'short-id' }));

    assert.equal(counters.finalize, 0, 'must not finalize a fragment');
    assert.equal(
      counters.cleanup >= 1,
      true,
      'staging file must be cleaned up',
    );
    assert.equal(
      finalized.size,
      0,
      'nothing may be bound to the fragment hash',
    );
  });

  function cacheFor(payload: string, attributes: any) {
    const { store, counters } = makeStore();
    const cache = new ReadThroughDataCache({
      log,
      dataSource: makeSource(payload),
      dataStore: store,
      metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
      contiguousDataIndex: dataIndex,
      dataContentAttributeImporter: attributeImporter,
      dataAttributesStore: {
        getDataAttributes: async () => attributes,
        setDataAttributes: async () => undefined,
      } as any,
    });
    return { cache, counters };
  }

  it('caches a payload that exactly matches the indexed payload size', async () => {
    const payload = 'x'.repeat(4096);
    const { cache, counters } = cacheFor(payload, {
      itemSize: payload.length + 1131,
      rootDataItemOffset: 1628,
      rootDataOffset: 1628 + 1131,
    });

    await drain(await cache.getData({ id: 'ok-id' }));

    assert.equal(counters.finalize, 1, 'a legitimate payload must still cache');
  });

  it('caches an item whose header is far larger than any fixed allowance', async () => {
    // ANS-104 tags are variable-length and processBundleStream reads whatever
    // tagsBytesLength an item declares — it does not apply DataItem.verify's
    // 4 KiB tag limit — so a legitimately indexed item can carry a header of
    // any size. A guard using a fixed slack would classify this complete
    // payload as short and silently stop caching it.
    const payload = 'x'.repeat(4096);
    const hugeHeader = 512 * 1024;
    const { cache, counters } = cacheFor(payload, {
      itemSize: payload.length + hugeHeader,
      rootDataItemOffset: 1000,
      rootDataOffset: 1000 + hugeHeader,
    });

    await drain(await cache.getData({ id: 'big-header-id' }));

    assert.equal(
      counters.finalize,
      1,
      'a large header must not be mistaken for a truncated payload',
    );
  });

  it('does not reject when the offsets needed for the header are missing', async () => {
    // itemSize alone cannot separate header from payload, so the guard must
    // stand down rather than guess.
    const { cache, counters } = cacheFor('R', { itemSize: 24106479 });

    await drain(await cache.getData({ id: 'no-offsets-id' }));

    assert.equal(counters.finalize, 1);
  });

  it('stands down when itemSize is null (raw NULL column)', async () => {
    const { cache, counters } = cacheFor('R', {
      itemSize: null,
      rootDataItemOffset: 1628,
      rootDataOffset: 2759,
    });

    await drain(await cache.getData({ id: 'null-itemsize' }));

    // Cannot compute a payload without itemSize, so it must fail open rather
    // than compute a nonsense one from a coerced null.
    assert.equal(counters.finalize, 1);
  });

  it('stands down when an offset is null (raw NULL column)', async () => {
    const { cache, counters } = cacheFor('R', {
      itemSize: 24106479,
      rootDataItemOffset: null,
      rootDataOffset: 2759,
    });

    await drain(await cache.getData({ id: 'null-offset' }));

    assert.equal(counters.finalize, 1);
  });

  it('does not reject when the item size is unknown', async () => {
    // No ANS-104 record (e.g. an L1 transaction): the guard must stay out of
    // the way rather than refuse to cache anything it cannot cross-check.
    const { store, counters } = makeStore();
    const cache = makeCache({}, store);

    await drain(await cache.getData({ id: 'no-attrs-id' }));

    assert.equal(counters.finalize, 1);
  });

  it("does not reject when the guard's attribute lookup throws", async () => {
    // A transient index error at guard time must not become a silent cache
    // bypass. Only the guard's own lookup fails here — the earlier lookup in
    // getData succeeds, so this isolates the guard rather than the whole path.
    const { store, counters } = makeStore();
    let calls = 0;
    const cache = new ReadThroughDataCache({
      log,
      dataSource: makeSource('R'),
      dataStore: store,
      metadataStore: makeContiguousMetadataStore({ log, type: 'node' }),
      contiguousDataIndex: dataIndex,
      dataContentAttributeImporter: attributeImporter,
      dataAttributesStore: {
        getDataAttributes: async () => {
          calls++;
          if (calls === 1) return undefined;
          throw new Error('index unavailable');
        },
        setDataAttributes: async () => undefined,
      } as any,
    });

    await drain(await cache.getData({ id: 'throws-id' }));

    assert.equal(calls > 1, true, 'the guard must have attempted a lookup');
    assert.equal(
      counters.finalize,
      1,
      'a lookup failure must not block caching',
    );
  });
});
