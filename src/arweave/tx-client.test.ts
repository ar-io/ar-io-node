import chai, { expect } from 'chai';
import fs from 'fs';
import { stdout } from 'process';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';

import { ArweaveClientStub } from '../../test/stubs.js';
import { TxClient } from './tx-client.js';

chai.use(sinonChai);

describe('TxClient', () => {
  let log: winston.Logger;
  let clientStub: ArweaveClientStub;
  let txClient: TxClient;

  beforeEach(() => {
    log = winston.createLogger({ silent: true });
    clientStub = new ArweaveClientStub();
    txClient = new TxClient({ log, client: clientStub });
  });

  describe('getTxData', () => {
    describe('an invalid transaction id', () => {
      it('should throw an error', async () => {
        await expect(txClient.getTxData('bad-tx-id')).to.be.rejected;
      });
    });
    // describe('a single chunk transaction', () => {
    //   const SMALL_TX_ID = '8V0K0DltgqPzBDa_FYyOdWnfhSngRj7ORH0lnOeqChw';
    //   it('should fetch tx data by chunks', async () => {
    //     const { data, size } = await txClient.getTxData(SMALL_TX_ID);
    //     expect(size).not.to.be.undefined;
    //     expect(data.readable).to.be.true;
    //   });
    //   it('fetched chunks should be correct size', async () => {
    //     const { data, size } = await txClient.getTxData(SMALL_TX_ID);
    //     expect(size).not.to.be.undefined;
    //     data.on('error', () => {
    //       console.log('welp, here is the errorr');
    //     });
    //     data.on('end', () => {
    //       console.log('done!');
    //     });
    //     data.pipe(log);
    //   });
    // });
    describe('a multi chunk transaction', () => {
      const MULTI_CHUNK_TX_ID = '----LT69qUmuIeC4qb0MZHlxVp7UxLu_14rEkA_9n6w';
      it('should fetch tx data by chunks', async function (done) {
        const { data, size } = await txClient.getTxData(MULTI_CHUNK_TX_ID);
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
        data.pipe(log);
      });
    });
  });
});
