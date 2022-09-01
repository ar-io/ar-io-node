/**
 * AR.IO Gateway
 * Copyright (C) 2022 Permanent Data Solutions, Inc
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
import { expect } from 'chai';
import * as sinon from 'sinon';
import stream from 'stream';
import * as winston from 'winston';

import { importAns104Bundle } from '../../src/lib/bundles.js';
import logger from '../../src/log.js';
import { BundleDatabase, DataItem } from '../../src/types.js';
import { stubAns104Bundle, stubTxID } from '../../test/stubs.js';

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

  afterEach(() => {
    sinon.restore();
  });

  it('should proccess bundles and save data items to the database using default batch size', async () => {
    const result = await importAns104Bundle({
      log: log,
      db: bundleDb,
      bundleStream: ans104Bundle,
      parentTxId: stubTxID,
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
      batchSize: 1,
    });
    expect(result).not.to.throw;
    expect(saveDbSpy.calledTwice).to.be.ok;
  });
});
