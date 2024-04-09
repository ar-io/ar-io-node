/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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
} from '../types.js';
import { ReadThroughDataCache } from './read-through-data-cache.js';

describe('ReadThroughDataCache', function () {
  let log: winston.Logger;
  let mockContiguousDataSource: ContiguousDataSource;
  let mockContiguousDataStore: ContiguousDataStore;
  let mockContiguousDataIndex: ContiguousDataIndex;
  let readThroughDataCache: ReadThroughDataCache;

  before(() => {
    log = winston.createLogger({ silent: true });
  });

  beforeEach(() => {
    const mockContiguousData: ContiguousData = {
      stream: new Readable(),
      size: 100,
      verified: false,
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
          write(chunk, _, callback) {
            console.log(chunk.toString());
            callback();
          },
        });
        return stream;
      },
      finalize: async (_, __) => {},
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
    };

    readThroughDataCache = new ReadThroughDataCache({
      log,
      dataSource: mockContiguousDataSource,
      dataStore: mockContiguousDataStore,
      contiguousDataIndex: mockContiguousDataIndex,
    });
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

      const result = await readThroughDataCache.getData('test-id');

      assert.deepEqual(result, {
        hash: 'test-hash',
        stream: result.stream,
        size: 100,
        sourceContentType: 'plain/text',
        verified: true,
        cached: true,
      });
      assert.deepEqual(calledWithArgument!, 'test-hash');
    });

    it('should fetch data from the source and cache it when not available in cache', async function () {
      let calledWithArgument: string;
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
      mock.method(mockContiguousDataSource, 'getData', (id: string) => {
        calledWithArgument = id;
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
          cached: false,
        });
      });

      const result = await readThroughDataCache.getData('test-id');

      assert.deepEqual(calledWithArgument!, 'test-id');
      assert.deepEqual(
        (mockContiguousDataStore.createWriteStream as any).mock.callCount(),
        1,
      );

      assert.ok(result.stream instanceof Readable);
      assert.equal(result.size, 99);
      assert.equal(result.sourceContentType, 'plain/text');
      assert.equal(result.verified, true);
      assert.equal(result.cached, false);
    });
  });
});
