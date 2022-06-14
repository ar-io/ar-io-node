import { expect } from 'chai';
import * as sinon from 'sinon';
import { BundleDatabase } from '../../src/database/bundle.js';
import { importAns104Bundle } from '../../src/lib/bundles.js';
import { stubAns104Bundle, stubTxID } from '../stubs.js';
import * as winston from 'winston';

describe('importAns102Bundle', () => {
  it('should do something (placedholder test)', () => {
    expect(true).to.equal(true);
  });
});

describe('importAns104Bundle', () => {
  const bundleDb = new BundleDatabase();
  const log = sinon.stub(winston.createLogger());

  afterEach(function () {
    sinon.restore();
  });
  it('should proccess bundles and save data items to the database', async () => {
    const saveDbSpy = sinon.spy(bundleDb, 'saveDataItems');
    const testBundle = await stubAns104Bundle();
    const result = await importAns104Bundle({
      log: log,
      db: bundleDb,
      bundleStream: testBundle,
      parentTxId: stubTxID,
      batchSize: 10
    });
    expect(result).not.to.throw;
    expect(saveDbSpy.calledOnce).to.be.ok;
  });
});
