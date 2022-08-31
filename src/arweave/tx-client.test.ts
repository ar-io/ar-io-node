import chai, { expect } from 'chai';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';

import { ArweaveClientStub } from '../../test/stubs.js';
import { TxClient } from './tx-client.js';

chai.use(sinonChai);
const TX_ID = '----LT69qUmuIeC4qb0MZHlxVp7UxLu_14rEkA_9n6w';

describe('TxClient', () => {
  let log: winston.Logger;
  let clientStub: ArweaveClientStub;
  let txClient: TxClient;

  before(() => {
    log = winston.createLogger({ silent: true });
    clientStub = new ArweaveClientStub();
    txClient = new TxClient({ log, client: clientStub });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getTxData', () => {
    describe('an invalid transaction id', () => {
      it('should throw an error', async () => {
        await expect(txClient.getTxData('bad-tx-id')).to.be.rejectedWith(Error);
      });
    });
    describe('a valid transaction id', () => {
      it('should return chunk data of the correct size for a known chunk', (done) => {
        txClient.getTxData(TX_ID).then((res) => {
          const { data, size } = res;
          let bytes = 0;
          data.on('error', (err: any) => {
            done(err);
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
    describe('a missing piece of chunk data for a transaction', () => {
      it('should throw an error', async () => {
        const error = new Error('missing chunk');
        sinon.stub(clientStub, 'getChunkDataByAbsoluteOffset').throws(error);
        await expect(txClient.getTxData(TX_ID)).to.be.rejectedWith(error);
      });
    });
  });
});