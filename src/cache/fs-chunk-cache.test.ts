import chai, { expect } from 'chai';
import fs from 'fs';
import sinon, { SinonSandbox } from 'sinon';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';

import { ArweaveChunkSourceStub } from '../../test/stubs.js';
import { fromB64Url } from '../lib/encoding.js';
import { JsonChunk } from '../types.js';
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

  describe('getChunkByRelativeOrAbsoluteOffset', () => {
    it('should call chunkSource to retrieve chunk', async () => {
      const spy = sandbox.spy(
        chunkSource,
        'getChunkByRelativeOrAbsoluteOffset',
      );
      await chunkCache.getChunkByRelativeOrAbsoluteOffset(
        ABSOLUTE_OFFSET,
        fromB64Url(B64_DATA_ROOT),
        0,
      );
      expect(spy).to.have.been.called;
    });
  });

  describe('getChunkDataByRelativeOrAbsoluteOffset', () => {
    let mockedJsonChunk: JsonChunk;
    let mockedChunkData: Buffer;

    before(() => {
      mockedJsonChunk = JSON.parse(
        fs.readFileSync(
          `test/mock_files/chunks/${ABSOLUTE_OFFSET}.json`,
          'utf-8',
        ),
      );
      mockedChunkData = fs.readFileSync(
        `test/mock_files/chunks/${B64_DATA_ROOT}/data/${RELATIVE_OFFSET}`,
      );
    });

    it('should fetch from cache when available', async () => {
      // mock the file exists
      const cacheGetSpy = sandbox
        .stub(chunkCache, 'getChunkData')
        .resolves(mockedChunkData);
      const networkSpy = sandbox.spy(
        chunkCache,
        'getChunkByRelativeOrAbsoluteOffset',
      );
      const readableChunk =
        await chunkCache.getChunkDataByRelativeOrAbsoluteOffset(
          ABSOLUTE_OFFSET,
          fromB64Url(B64_DATA_ROOT),
          0,
        );
      expect(networkSpy).not.to.have.been.called;
      expect(cacheGetSpy).to.have.been.called;
      const fetchedChunkData: any[] = [];
      readableChunk.on('data', (d) => {
        fetchedChunkData.push(d);
      });
      readableChunk.on('end', () => {
        const fetchedBuffer = Buffer.concat(fetchedChunkData);
        expect(fetchedBuffer).to.deep.equal(mockedChunkData);
      });
    });

    it('should fetch from network when not in local cache', async () => {
      // mock file does not exist
      const cacheHasSpy = sandbox
        .stub(chunkCache, 'hasChunkData')
        .resolves(false);
      const cacheGetSpy = sandbox.spy(chunkCache, 'getChunkData');
      const networkSpy = sandbox
        .stub(chunkCache, 'getChunkByRelativeOrAbsoluteOffset')
        .resolves(mockedJsonChunk);
      await chunkCache.getChunkDataByRelativeOrAbsoluteOffset(
        ABSOLUTE_OFFSET,
        fromB64Url(B64_DATA_ROOT),
        0,
      );
      expect(cacheGetSpy).to.have.been.called;
      expect(cacheHasSpy).to.have.been.called;
      expect(networkSpy).to.have.been.called;
      const fetchedBuffer = fromB64Url(mockedJsonChunk.chunk);
      expect(fetchedBuffer).to.deep.equal(mockedChunkData);
    });
  });
});
