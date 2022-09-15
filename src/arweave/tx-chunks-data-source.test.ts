import chai, { expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import { Readable } from 'stream';
import * as winston from 'winston';

import {
  ArweaveChainSourceStub,
  ArweaveChunkSourceStub,
} from '../../test/stubs.js';
import { TxChunksDataSource } from './tx-chunks-data-source.js';

chai.use(sinonChai);
const TX_ID = '----LT69qUmuIeC4qb0MZHlxVp7UxLu_14rEkA_9n6w';

describe('TxChunksDataSource', () => {
  let log: winston.Logger;
  let chainSource: ArweaveChainSourceStub;
  let chunkSource: ArweaveChunkSourceStub;
  let txChunkRetriever: TxChunksDataSource;

  before(() => {
    log = winston.createLogger({ silent: true });
    chainSource = new ArweaveChainSourceStub();
    chunkSource = new ArweaveChunkSourceStub();
    txChunkRetriever = new TxChunksDataSource({
      log,
      chainSource,
      chunkSource,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getTxData', () => {
    describe('an invalid transaction id', () => {
      it('should throw an error', async () => {
        await expect(
          txChunkRetriever.getTxData('bad-tx-id'),
        ).to.be.rejectedWith(Error);
      });
    });

    describe('a valid transaction id', () => {
      it('should return chunk data of the correct size for a known chunk', (done) => {
        txChunkRetriever
          .getTxData(TX_ID)
          .then((res: { data: Readable; size: number }) => {
            const { data, size } = res;
            let bytes = 0;
            data.on('error', (error: any) => {
              done(error);
            });
            data.on('data', (c) => {
              bytes += c.length;
            });
            data.on('end', () => {
              expect(bytes).to.equal(size);
              done();
            });
          });
      });
    });

    describe('a bad piece of chunk data', () => {
      it('should throw an error', function (done) {
        const error = new Error('missing chunk');
        const badReadable = new Readable({
          read: function () {
            this.emit('error', error);
          },
        });
        sinon
          .stub(chunkSource, 'getChunkDataByRelativeOrAbsoluteOffset')
          .resolves(badReadable);
        txChunkRetriever
          .getTxData(TX_ID)
          .then((res: { data: Readable; size: number }) => {
            const { data } = res;
            data.on('error', (error: any) => {
              expect(error).to.deep.equal(error);
              done();
            });
            // do nothing
            data.on('data', () => {
              return;
            });
          });
      });

      describe('an invalid chunk', () => {
        it('should throw an error', function (done) {
          const error = new Error('Invalid chunk');
          sinon
            .stub(chunkSource, 'getChunkByRelativeOrAbsoluteOffset')
            .rejects(error);
          txChunkRetriever
            .getTxData(TX_ID)
            .then((res: { data: Readable; size: number }) => {
              const { data } = res;
              data.on('error', (error: any) => {
                expect(error).to.deep.equal(error);
                done();
              });
              // do nothing
              data.on('data', () => {
                return;
              });
            });
        });
      });
    });
  });
});
