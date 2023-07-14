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
import chai, { expect } from 'chai';
import fs from 'node:fs';
import sinon, { SinonSandbox } from 'sinon';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';

import { ArweaveChunkSourceStub } from '../../test/stubs.js';
import { fromB64Url } from '../lib/encoding.js';
import { FsChunkDataStore } from '../store/fs-chunk-data-store.js';
import { Chunk, ChunkData, ChunkDataStore } from '../types.js';
import { ReadThroughChunkDataCache } from './read-through-chunk-data-cache.js';

chai.use(sinonChai);
const B64_DATA_ROOT = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
const TX_SIZE = 256000;
const ABSOLUTE_OFFSET = 51530681327863;
const RELATIVE_OFFSET = 0;

describe('ReadThroughChunkDataCache', () => {
  let log: winston.Logger;
  let chunkSource: ArweaveChunkSourceStub;
  let chunkDataStore: ChunkDataStore;
  let chunkCache: ReadThroughChunkDataCache;
  let sandbox: SinonSandbox;

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

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

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
      const dataRootBuffer = txPath.slice(-64, -32);
      const dataPath = fromB64Url(jsonChunk.data_path);
      const hash = dataPath.slice(-64, -32);
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

    it('should fetch chunk data from cache when available', async () => {
      // mock the file exists
      const storeGetSpy = sandbox
        .stub(chunkDataStore, 'get')
        .resolves(mockedChunkData);
      const networkSpy = sandbox.spy(chunkSource, 'getChunkByAny');
      await chunkCache.getChunkDataByAny(
        TX_SIZE,
        ABSOLUTE_OFFSET,
        B64_DATA_ROOT,
        0,
      );
      expect(networkSpy).not.to.have.been.called;
      expect(storeGetSpy).to.have.been.called;
    });

    it('should fetch chunk data from network when not in local cache', async () => {
      // mock file does not exist
      const storeHasSpy = sandbox.stub(chunkDataStore, 'has').resolves(false);
      const storeGetSpy = sandbox.spy(chunkDataStore, 'get');
      const networkSpy = sandbox
        .stub(chunkSource, 'getChunkByAny')
        .resolves(mockedChunk);
      await chunkCache.getChunkDataByAny(
        TX_SIZE,
        ABSOLUTE_OFFSET,
        B64_DATA_ROOT,
        0,
      );
      expect(storeGetSpy).to.have.been.called;
      expect(storeHasSpy).to.have.been.called;
      expect(networkSpy).to.have.been.called;
    });

    it('should fetch chunk data from network when an error occurs fetching from local cache', async () => {
      const storeHasSpy = sandbox.stub(chunkDataStore, 'has').rejects();
      const storeGetSpy = sandbox.spy(chunkDataStore, 'get');
      const networkSpy = sandbox
        .stub(chunkSource, 'getChunkByAny')
        .resolves(mockedChunk);
      await chunkCache.getChunkDataByAny(
        TX_SIZE,
        ABSOLUTE_OFFSET,
        B64_DATA_ROOT,
        0,
      );
      expect(storeGetSpy).to.have.been.called;
      expect(storeHasSpy).to.have.been.called;
      expect(networkSpy).to.have.been.called;
    });
  });
});
