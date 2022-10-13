import chai, { expect } from 'chai';
import fs from 'fs';
import sinon, { SinonSandbox } from 'sinon';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';

import { ArweaveChunkSourceStub } from '../../test/stubs.js';
import { fromB64Url } from '../lib/encoding.js';
import { Chunk } from '../types.js';
import { FsChunkCache } from './fs-chunk-cache.js';

chai.use(sinonChai);
const B64_DATA_ROOT = 'wRq6f05oRupfTW_M5dcYBtwK5P8rSNYu20vC6D_o-M4';
const ABSOLUTE_OFFSET = 51530681327863;
const RELATIVE_OFFSET = 0;

describe('FsChunkCache', () => {
  let log: winston.Logger;
  let chunkSource: ArweaveChunkSourceStub;
  let chunkCache: FsChunkCache;
  let sandbox: SinonSandbox;

  before(() => {
    log = winston.createLogger({ silent: true });
    chunkSource = new ArweaveChunkSourceStub();
    chunkCache = new FsChunkCache({
      log,
      chunkSource,
    });
  });

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('getChunkDataByAbsoluteOrRelativeOffset', () => {
    let mockedChunk: Chunk;
    let mockedChunkData: Buffer;

    before(() => {
      const jsonChunk = JSON.parse(
        fs.readFileSync(
          `test/mock_files/chunks/${ABSOLUTE_OFFSET}.json`,
          'utf-8',
        ),
      );
      mockedChunk = {
        chunk: fromB64Url(jsonChunk.chunk),
        data_path: fromB64Url(jsonChunk.data_path),
        tx_path: fromB64Url(jsonChunk.tx_path),
      };
      mockedChunkData = fs.readFileSync(
        `test/mock_files/chunks/${B64_DATA_ROOT}/data/${RELATIVE_OFFSET}`,
      );
    });

    it('should fetch chunk data from cache when available', async () => {
      // mock the file exists
      const cacheGetSpy = sandbox
        .stub(chunkCache, 'getChunkData')
        .resolves(mockedChunkData);
      const networkSpy = sandbox.spy(
        chunkSource,
        'getChunkByAbsoluteOrRelativeOffset',
      );
      await chunkCache.getChunkDataByAbsoluteOrRelativeOffset(
        ABSOLUTE_OFFSET,
        fromB64Url(B64_DATA_ROOT),
        0,
      );
      expect(networkSpy).not.to.have.been.called;
      expect(cacheGetSpy).to.have.been.called;
    });

    it('should fetch chunk data from network when not in local cache', async () => {
      // mock file does not exist
      const cacheHasSpy = sandbox
        .stub(chunkCache, 'hasChunkData')
        .resolves(false);
      const cacheGetSpy = sandbox.spy(chunkCache, 'getChunkData');
      const networkSpy = sandbox
        .stub(chunkSource, 'getChunkByAbsoluteOrRelativeOffset')
        .resolves(mockedChunk);
      await chunkCache.getChunkDataByAbsoluteOrRelativeOffset(
        ABSOLUTE_OFFSET,
        fromB64Url(B64_DATA_ROOT),
        0,
      );
      expect(cacheGetSpy).to.have.been.called;
      expect(cacheHasSpy).to.have.been.called;
      expect(networkSpy).to.have.been.called;
    });

    it('should fetch chunk data from network when an error occurs fetching from local cache', async () => {
      const cacheHasSpy = sandbox.stub(chunkCache, 'hasChunkData').rejects();
      const cacheGetSpy = sandbox.spy(chunkCache, 'getChunkData');
      const networkSpy = sandbox
        .stub(chunkSource, 'getChunkByAbsoluteOrRelativeOffset')
        .resolves(mockedChunk);
      await chunkCache.getChunkDataByAbsoluteOrRelativeOffset(
        ABSOLUTE_OFFSET,
        fromB64Url(B64_DATA_ROOT),
        0,
      );
      expect(cacheGetSpy).to.have.been.called;
      expect(cacheHasSpy).to.have.been.called;
      expect(networkSpy).to.have.been.called;
    });
  });
});
