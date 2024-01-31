/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
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
import winston from 'winston';
import { Ans104Unbundler } from './ans104-unbundler.js';
import { BundleDataImporter } from './bundle-data-importer.js';
import { expect } from 'chai';
import sinon from 'sinon';

describe('BundleDataImporter', () => {
  let bundleDataImporter: BundleDataImporter;
  let bundleDataImporterWithFullQueue: BundleDataImporter;
  let log: winston.Logger;
  let mockContiguousDataSource: any;
  let mockAns104Unbundler: Ans104Unbundler;
  let mockItem: any;
  let mockData: any;
  let sandbox: sinon.SinonSandbox;

  before(() => {
    log = winston.createLogger({ silent: true });
  });

  beforeEach(() => {
    mockContiguousDataSource = {
      getData: sinon.stub(),
    };
    mockAns104Unbundler = sinon.createStubInstance(Ans104Unbundler);
    mockItem = { id: 'testId', index: 1 };
    mockData = { stream: { on: sinon.stub(), resume: sinon.stub() } };

    bundleDataImporter = new BundleDataImporter({
      log,
      contiguousDataSource: mockContiguousDataSource,
      ans104Unbundler: mockAns104Unbundler,
      workerCount: 1,
      maxQueueSize: 1,
    });

    bundleDataImporterWithFullQueue = new BundleDataImporter({
      log,
      contiguousDataSource: mockContiguousDataSource,
      ans104Unbundler: mockAns104Unbundler,
      workerCount: 1,
      maxQueueSize: 0,
    });

    sandbox = sinon.createSandbox();
  });

  describe('queueItem', () => {
    it('should queue a non-prioritized item if queue is not full', async () => {
      await bundleDataImporter.queueItem(mockItem, false);
      expect(mockContiguousDataSource.getData).to.be.calledWith(mockItem.id);
    });

    it('should not queue a non-prioritized item if queue is full', async () => {
      await bundleDataImporterWithFullQueue.queueItem(mockItem, false);
      expect(mockContiguousDataSource.getData).to.not.be.called;
    });

    it('should queue a prioritized item if the queue is not full', async () => {
      await bundleDataImporter.queueItem(mockItem, true);
      expect(mockContiguousDataSource.getData).to.be.calledWith(mockItem.id);
    });

    it('should queue a prioritized item if the queue is full', async () => {
      await bundleDataImporterWithFullQueue.queueItem(mockItem, true);
      expect(mockContiguousDataSource.getData).to.be.calledWith(mockItem.id);
    });
  });

  describe('download', () => {
    it('should download and queue the item for unbundling', async () => {
      mockData.stream.on.callsArgOn(1, mockData.stream);
      mockContiguousDataSource.getData.returns(mockData);
      await bundleDataImporter.download({ item: mockItem, prioritized: true });
      expect(mockAns104Unbundler.queueItem).to.be.calledWith(mockItem, true);
    });

    it('should handle download errors', async () => {
      const error = new Error('Download error');
      mockData.stream.on.onSecondCall().callsArgWith(1, error);
      mockContiguousDataSource.getData.returns(mockData);
      try {
        await bundleDataImporter.download({
          item: mockItem,
          prioritized: true,
        });
      } catch (error) {
        expect(error).to.not.be.undefined;
      }
      expect(mockAns104Unbundler.queueItem).to.not.be.called;
    });
  });
});
