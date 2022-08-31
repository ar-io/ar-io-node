import chai, { expect } from 'chai';
import sinonChai from 'sinon-chai';
import * as winston from 'winston';

import { ArweaveClientStub } from '../../test/stubs.js';
import { TxClient } from './tx-client.js';

chai.use(sinonChai);
const TX_ID = '8V0K0DltgqPzBDa_FYyOdWnfhSngRj7ORH0lnOeqChw';

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
    it('should fetch tx data by chunks', async () => {
      const { data, size } = await txClient.getTxData(TX_ID);
      let returnedSize = 0;
      data.on('data', (c) => {
        returnedSize += c.length;
      });

      data.on('end', () => {
        expect(returnedSize).to.equal(size);
      });
    });

    it('should throw an error if unable to fetch chunk data', async () => {
      await expect(txClient.getTxData('bad-tx-id')).to.be.rejected;
    });
  });
});
