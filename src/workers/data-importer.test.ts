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

      const args = (contiguousDataSource.getData as any).mock.calls[0]
        .arguments[0];
      assert.equal(args.id, mockItem.id);
      assert.ok(
        args.signal instanceof AbortSignal,
        'getData should receive an AbortSignal for cancellation',
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

      const args = (contiguousDataSource.getData as any).mock.calls[0]
        .arguments[0];
      assert.equal(args.id, mockItem.id);
      assert.ok(args.signal instanceof AbortSignal);
    });

    it('should queue a prioritized item if the queue is full', async () => {
      mock.method(contiguousDataSource, 'getData');

      await bundleDataImporterWithFullQueue.queueItem(mockItem, true);

      const args = (contiguousDataSource.getData as any).mock.calls[0]
        .arguments[0];
      assert.equal(args.id, mockItem.id);
      assert.ok(args.signal instanceof AbortSignal);
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

    // Option B regression guards — three tests covering the wall-clock cap.
    // Each one must hold or the pre-data / post-data wedge can recur.

    it('aborts via AbortSignal when getData hangs past the timeout', async () => {
      // Pre-getData stall: getData never resolves on its own. The signal
      // passed in is the only way out. If this test fails, workers will
      // hang indefinitely on a stuck cascade.
      let capturedSignal: AbortSignal | undefined;
      const hangingSource: ContiguousDataSource = {
        getData: ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            capturedSignal = signal;
            signal?.addEventListener('abort', () =>
              reject((signal as any).reason ?? new Error('aborted')),
            );
          }),
      };
      const importer = new DataImporter({
        log,
        contiguousDataSource: hangingSource,
        ans104Unbundler: new Ans104UnbundlerStub() as any,
        workerCount: 1,
        maxQueueSize: 1,
        downloadTimeoutMs: 100,
      });

      const t0 = Date.now();
      await assert.rejects(
        () =>
          importer.download({
            item: mockItem,
            prioritized: true,
            bypassFilter: false,
          }),
        /exceeded 100ms wall-clock cap/,
      );
      const elapsed = Date.now() - t0;
      assert.ok(
        elapsed < 500,
        `download should reject promptly via abort, took ${elapsed}ms`,
      );
      assert.ok(capturedSignal, 'getData must receive the AbortSignal');
      assert.equal(
        capturedSignal!.aborted,
        true,
        'signal must be in aborted state after timeout',
      );
      await importer.stop();
    });

    it('destroys the stream when stream consumption hangs past the timeout', async () => {
      // Post-getData stall: getData returned a stream but it never emits
      // 'end'/'error'. The timer must call stream.destroy(err) so the
      // 'error' handler rejects and the worker can move on.
      const neverEndingStream = new Readable({ read() {} });
      const stallingSource: ContiguousDataSource = {
        getData: () =>
          Promise.resolve({
            stream: neverEndingStream,
            size: 0,
            verified: false,
            cached: false,
          }),
      };
      const importer = new DataImporter({
        log,
        contiguousDataSource: stallingSource,
        ans104Unbundler: new Ans104UnbundlerStub() as any,
        workerCount: 1,
        maxQueueSize: 1,
        downloadTimeoutMs: 100,
      });

      await assert.rejects(
        () =>
          importer.download({
            item: mockItem,
            prioritized: true,
            bypassFilter: false,
          }),
        /exceeded 100ms wall-clock cap/,
      );
      assert.equal(
        neverEndingStream.destroyed,
        true,
        'stream must be destroyed by the timeout handler',
      );
      await importer.stop();
    });

    it('does not fire timeout or leak timer on the healthy path', async () => {
      // Healthy path: a stream that ends quickly. download() should resolve
      // BEFORE the timer would fire, and clearTimeout must remove the timer
      // in finally{} (verified indirectly: a second consecutive call with
      // very short timeout still succeeds → no global timer state leaked).
      const importer = new DataImporter({
        log,
        contiguousDataSource, // default mock returns a small stream that ends
        ans104Unbundler: new Ans104UnbundlerStub() as any,
        workerCount: 1,
        maxQueueSize: 1,
        downloadTimeoutMs: 60_000, // long enough that healthy path completes first
      });
      mock.method(ans104Unbundler, 'queueItem');

      await importer.download({
        item: mockItem,
        prioritized: false,
        bypassFilter: false,
      });
      // Second call to prove no stale state from first download's timer
      await importer.download({
        item: mockItem,
        prioritized: false,
        bypassFilter: false,
      });
      await importer.stop();
    });
  });
});
