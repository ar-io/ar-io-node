import chai, { expect } from 'chai';
import { assert } from 'console';
import { stdout } from 'process';
import sinonChai from 'sinon-chai';
import { PassThrough, finished, pipeline } from 'stream';
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
    describe('a single chunk transaction', () => {
      const SMALL_TX_ID = '8V0K0DltgqPzBDa_FYyOdWnfhSngRj7ORH0lnOeqChw';
      it('should fetch tx data by chunks', async () => {
        const { data, size } = await txClient.getTxData(SMALL_TX_ID);
        expect(size).not.to.be.undefined;
        expect(data.pipe(log)).not.to.throw;
      });
    });
    describe('a multi chunk transaction', () => {
      const MULTI_CHUNK_TX_ID = '--1KPv3FTumifIQ2vbGHqqsWh2sKr_H-u8ticjVK08A';
      it('should fetch tx data by chunks', async () => {
        const { data, size } = await txClient.getTxData(MULTI_CHUNK_TX_ID);
        expect(size).not.to.be.undefined;
        expect(data.pipe(log)).not.to.throw;
      });
    });
  });
});
