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
import fs from 'node:fs';
import { strict as assert } from 'node:assert';
import { afterEach, before, describe, it, mock } from 'node:test';
import * as winston from 'winston';

import { ArweaveChunkSourceStub } from '../../test/stubs.js';
import { fromB64Url } from '../lib/encoding.js';
import { FsChunkDataStore } from '../store/fs-chunk-data-store.js';
import { Chunk, ChunkData, ChunkDataStore } from '../types.js';
import { ReadThroughChunkDataCache } from './read-through-chunk-data-cache.js';

const B64_DATA_ROOT = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
const TX_SIZE = 256000;
const ABSOLUTE_OFFSET = 51530681327863;
const RELATIVE_OFFSET = 0;

let log: winston.Logger;
let chunkSource: ArweaveChunkSourceStub;
let chunkDataStore: ChunkDataStore;
let chunkCache: ReadThroughChunkDataCache;

before(() => {
  log = winston.createLogger({ silent: true });
  chunkSource = new ArweaveChunkSourceStub();
  chunkDataStore = new FsChunkDataStore({
    log,
    baseDir: 'data/chunks',
  });
  chunkCache = new ReadThroughChunkDataCache({
    log,
    chunkSource,
    chunkDataStore,
  });
});

describe('ReadThroughChunkDataCache', () => {
  // TODO remove mocks from tests
  describe('getChunkDataByAny', () => {
    let mockedChunk: Chunk;
    let mockedChunkData: ChunkData;

    before(() => {
      const jsonChunk = JSON.parse(
        fs.readFileSync(
          `test/mock_files/chunks/${ABSOLUTE_OFFSET}.json`,
          'utf-8',
        ),
      );
      const txPath = fromB64Url(jsonChunk.tx_path);
      const dataRootBuffer = txPath.subarray(-64, -32);
      const dataPath = fromB64Url(jsonChunk.data_path);
      const hash = dataPath.subarray(-64, -32);
      mockedChunk = {
        tx_path: txPath,
        data_root: dataRootBuffer,
        data_size: TX_SIZE,
        data_path: dataPath,
        offset: RELATIVE_OFFSET,
        hash,
        chunk: fromB64Url(jsonChunk.chunk),
      };
      const chunk = fs.readFileSync(
        `test/mock_files/chunks/${B64_DATA_ROOT}/data/${RELATIVE_OFFSET}`,
      );
      mockedChunkData = {
        hash,
        chunk,
      };
    });

    afterEach(() => {
      mock.restoreAll();
    });

    it('should fetch chunk data from cache when available', async () => {
      mock.method(chunkDataStore, 'get', async () => mockedChunkData);
      mock.method(chunkSource, 'getChunkByAny');

      await chunkCache.getChunkDataByAny({
        txSize: TX_SIZE,
        absoluteOffset: ABSOLUTE_OFFSET,
        dataRoot: B64_DATA_ROOT,
        relativeOffset: 0,
      });

      assert.deepEqual((chunkSource.getChunkByAny as any).mock.callCount(), 0);
      assert.deepEqual((chunkDataStore.get as any).mock.callCount(), 1);
    });

    it('should fetch chunk data from network when not in local cache', async () => {
      const chuunkDataStoreHasSpy = mock.method(
        chunkDataStore,
        'has',
        async () => false,
      );
      const chunkDataStoreGetSpy = mock.method(chunkDataStore, 'get');
      const networkSpy = mock.method(
        chunkSource,
        'getChunkByAny',
        async () => mockedChunk,
      );
      await chunkCache.getChunkDataByAny({
        txSize: TX_SIZE,
        absoluteOffset: ABSOLUTE_OFFSET,
        dataRoot: B64_DATA_ROOT,
        relativeOffset: 0,
      });
      assert.deepEqual(chunkDataStoreGetSpy.mock.callCount(), 1);
      assert.deepEqual(chuunkDataStoreHasSpy.mock.callCount(), 1);
      assert.deepEqual(networkSpy.mock.callCount(), 1);
    });

    it('should fetch chunk data from network when an error occurs fetching from local cache', async () => {
      const storeHasSpy = mock.method(chunkDataStore, 'has', async () => {
        throw new Error('Error');
      });
      const storeGetSpy = mock.method(chunkDataStore, 'get');
      const networkSpy = mock.method(
        chunkSource,
        'getChunkByAny',
        async () => mockedChunk,
      );
      await chunkCache.getChunkDataByAny({
        txSize: TX_SIZE,
        absoluteOffset: ABSOLUTE_OFFSET,
        dataRoot: B64_DATA_ROOT,
        relativeOffset: 0,
      });

      assert.deepEqual(storeGetSpy.mock.callCount(), 1);
      assert.deepEqual(storeHasSpy.mock.callCount(), 1);
      assert.deepEqual(networkSpy.mock.callCount(), 1);
    });
  });
});
