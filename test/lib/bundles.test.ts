import { expect } from 'chai';
import * as sinon from 'sinon';
import stream from 'stream';
import { importAns104Bundle } from '../../src/lib/bundles.js';
import { stubAns104Bundle, stubTxID } from '../stubs.js';
import * as winston from 'winston';
import { DataItem, BundleDatabase } from '../../src/types.js';
import logger from '../../src/log.js';

export class BundleDatabaseStub implements BundleDatabase {
  private log: winston.Logger;

  constructor() {
    this.log = logger;
  }

  async saveDataItems(dataItems: DataItem[]): Promise<void> {
    this.log.info(`Saving ${dataItems.length} data items to bundle database`);
    return await new Promise((resolve) => resolve());
  }
}

describe('importAns102Bundle', () => {
  it('should do something (placedholder test)', () => {
    expect(true).to.equal(true);
  });
});

describe('importAns104Bundle', () => {
  let log: winston.Logger;
  let bundleDb: BundleDatabase;
  let saveDbSpy: sinon.SinonSpy;
  let ans104Bundle: stream.Readable;

  beforeEach(async () => {
    log = sinon.stub(winston.createLogger());
    bundleDb = new BundleDatabaseStub();
    saveDbSpy = sinon.stub(bundleDb, 'saveDataItems');
    ans104Bundle = await stubAns104Bundle();
  });

  afterEach(function () {
    sinon.restore();
  });

  it('should proccess bundles and save data items to the database using default batch size', async () => {
    const result = await importAns104Bundle({
      log: log,
      db: bundleDb,
      bundleStream: ans104Bundle,
      parentTxId: stubTxID
    });
    expect(result).not.to.throw;
    expect(saveDbSpy.calledOnce).to.be.ok;
  });

  it('should proccess bundles and save data items to the database with specifed batch size', async () => {
    const result = await importAns104Bundle({
      log: log,
      db: bundleDb,
      bundleStream: ans104Bundle,
      parentTxId: stubTxID,
      batchSize: 1
    });
    expect(result).not.to.throw;
    expect(saveDbSpy.calledTwice).to.be.ok;
  });
});
