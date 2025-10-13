/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, mock, afterEach } from 'node:test';
import { Ans104Unbundler, UnbundleableItem } from './ans104-unbundler.js';
import { EventEmitter } from 'node:events';
import { createTestLogger } from '../../test/test-logger.js';

describe('Ans104Unbundler', () => {
  let log: ReturnType<typeof createTestLogger>;
  let eventEmitter: EventEmitter;
  let filter: any;
  let contiguousDataSource: any;
  let ans104Unbundler: Ans104Unbundler;
  let shouldUnbundleMock: any;
  let mockAns104Parser: any;

  beforeEach(() => {
    log = createTestLogger({ suite: 'Ans104Unbundler' });
    eventEmitter = new EventEmitter();
    filter = { match: () => true };
    contiguousDataSource = {};
    shouldUnbundleMock = mock.fn(() => true);
    mockAns104Parser = {
      stop: mock.fn(),
      parseBundle: () => Promise.resolve(),
    };

    ans104Unbundler = new Ans104Unbundler({
      log,
      eventEmitter,
      filter,
      contiguousDataSource,
      dataItemIndexFilterString: '',
      workerCount: 1,
      maxQueueSize: 2,
      shouldUnbundle: shouldUnbundleMock,
      ans104Parser: mockAns104Parser,
    });
  });

  afterEach(async () => {
    await ans104Unbundler.stop();
    mock.restoreAll();
  });

  describe('queueItem', () => {
    const mockItem = {
      id: 'test-id',
    } as UnbundleableItem;

    it('should not queue item when shouldUnbundle returns false', async () => {
      shouldUnbundleMock.mock.mockImplementation(() => false);

      for (let i = 0; i < 10; i++) {
        ans104Unbundler.queueItem(mockItem, false);
      }

      assert.equal(shouldUnbundleMock.mock.calls.length, 10);
      assert.equal(ans104Unbundler.queueDepth(), 0);
    });

    it('should queue item when shouldUnbundle returns true', async () => {
      for (let i = 0; i < 10; i++) {
        ans104Unbundler.queueItem(mockItem, false);
      }

      assert.equal(shouldUnbundleMock.mock.calls.length, 10);
      assert.equal(ans104Unbundler.queueDepth(), 2);
    });

    it('should queue prioritized item even when shouldUnbundle returns false', async () => {
      shouldUnbundleMock.mock.mockImplementation(() => false);

      for (let i = 0; i < 10; i++) {
        ans104Unbundler.queueItem(mockItem, true);
      }

      assert.equal(shouldUnbundleMock.mock.calls.length, 10);
      assert.equal(ans104Unbundler.queueDepth(), 9);
    });

    it('should not call shouldUnbundle when workerCount is 0', async () => {
      ans104Unbundler['workerCount'] = 0;

      for (let i = 0; i < 10; i++) {
        ans104Unbundler.queueItem(mockItem, false);
      }

      assert.equal(shouldUnbundleMock.mock.calls.length, 0);
      assert.equal(ans104Unbundler.queueDepth(), 0);
    });

    it("should parse bundle even if filter doesn't match if bypassFilter is true", async () => {
      mock.method(mockAns104Parser, 'parseBundle');
      (ans104Unbundler as any).filter = { match: () => false };

      const mockItem = {
        id: 'test-id',
        root_tx_id: 'root_tx_id',
      } as UnbundleableItem;

      await ans104Unbundler.queueItem(mockItem, false, true);

      assert.deepEqual(
        (mockAns104Parser.parseBundle as any).mock.calls[0].arguments[0],
        {
          parentId: 'test-id',
          parentIndex: undefined,
          rootParentOffset: 0,
          rootTxId: 'root_tx_id',
        },
      );
    });
  });
});
