/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  mock,
} from 'node:test';
import { ContiguousDataSource } from '../types.js';
import { DataImporter } from './data-importer.js';
import { createTestLogger } from '../../test/test-logger.js';

class Ans104UnbundlerStub {
  async queueItem(): Promise<void> {
    return;
  }

  async unbundle(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }
}

describe('DataImporter', () => {
  let log: ReturnType<typeof createTestLogger>;
  let bundleDataImporter: DataImporter;
  let bundleDataImporterWithFullQueue: DataImporter;
  let contiguousDataSource: ContiguousDataSource;
  let ans104Unbundler: any;
  let mockItem: any;

  before(() => {
    log = createTestLogger({ suite: 'DataImporter' });

    mockItem = { id: 'testId', index: 1 };

    contiguousDataSource = {
      getData: () =>
        Promise.resolve({
          stream: Readable.from(Buffer.from('testing...')),
          size: 10,
          verified: false,
          cached: false,
        }),
    };
  });

  after(async () => {
    await bundleDataImporter.stop();
    await bundleDataImporterWithFullQueue.stop();
  });

  beforeEach(() => {
    ans104Unbundler = new Ans104UnbundlerStub();
    bundleDataImporter = new DataImporter({
      log,
      contiguousDataSource,
      ans104Unbundler,
      workerCount: 1,
      maxQueueSize: 1,
    });
    bundleDataImporterWithFullQueue = new DataImporter({
      log,
      contiguousDataSource,
      ans104Unbundler,
      workerCount: 1,
      maxQueueSize: 0,
    });
  });

  afterEach(async () => {
    mock.restoreAll();
  });

  describe('queueItem', () => {
    it('should queue a non-prioritized item if queue is not full', async () => {
      mock.method(contiguousDataSource, 'getData');

      await bundleDataImporter.queueItem(mockItem, false);

      assert.deepEqual(
        (contiguousDataSource.getData as any).mock.calls[0].arguments[0],
        { id: mockItem.id },
      );
    });

    it('should not queue a non-prioritized item if queue is full', async () => {
      mock.method(contiguousDataSource, 'getData');

      await bundleDataImporterWithFullQueue.queueItem(mockItem, false);

      assert.equal((contiguousDataSource.getData as any).mock.callCount(), 0);
    });

    it('should queue a prioritized item if the queue is not full', async () => {
      mock.method(contiguousDataSource, 'getData');

      await bundleDataImporter.queueItem(mockItem, true);

      assert.deepEqual(
        (contiguousDataSource.getData as any).mock.calls[0].arguments[0],
        { id: mockItem.id },
      );
    });

    it('should queue a prioritized item if the queue is full', async () => {
      mock.method(contiguousDataSource, 'getData');

      await bundleDataImporterWithFullQueue.queueItem(mockItem, true);

      assert.deepEqual(
        (contiguousDataSource.getData as any).mock.calls[0].arguments[0],
        { id: mockItem.id },
      );
    });
  });

  describe('download', () => {
    it('should download and queue the item for unbundling', async () => {
      mock.method(ans104Unbundler, 'queueItem');
      bundleDataImporter = new DataImporter({
        log,
        contiguousDataSource,
        ans104Unbundler: ans104Unbundler,
        workerCount: 1,
        maxQueueSize: 1,
      });

      await bundleDataImporter.download({
        item: mockItem,
        prioritized: true,
        bypassFilter: false,
      });

      assert.deepEqual(
        (ans104Unbundler.queueItem as any).mock.calls[0].arguments,
        [mockItem, true, false],
      );
    });

    it('should handle download errors', async () => {
      const error = new Error('Download error');
      mock.method(ans104Unbundler, 'queueItem');
      mock.method(contiguousDataSource, 'getData', () => Promise.reject(error));

      await assert.rejects(
        async () => {
          await bundleDataImporter.download({
            item: mockItem,
            prioritized: true,
            bypassFilter: false,
          });
        },
        {
          name: 'Error',
          message: 'Download error',
        },
      );
      assert.equal((ans104Unbundler.queueItem as any).mock.callCount(), 0);
    });
  });
});
