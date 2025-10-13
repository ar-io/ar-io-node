/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { MempoolWatcher } from './mempool-watcher.js';
import { ArweaveChainSourceStub } from '../../test/stubs.js';
import wait from '../lib/wait.js';
import { createTestLogger } from '../../test/test-logger.js';

describe('MempoolWatcher', () => {
  let log: ReturnType<typeof createTestLogger>;
  let chainSource: ArweaveChainSourceStub;
  let txFetcher: any;
  let mempoolWatcher: MempoolWatcher;

  before(() => {
    log = createTestLogger({ suite: 'MempoolWatcher' });
  });

  beforeEach(() => {
    chainSource = new ArweaveChainSourceStub();
    txFetcher = {
      queueTxId: async () => {
        Promise.resolve();
      },
    };
    mempoolWatcher = new MempoolWatcher({
      log,
      chainSource,
      txFetcher,
      mempoolPollingIntervalMs: 100,
    });
  });

  afterEach(async () => {
    await mempoolWatcher.stop();
    mock.restoreAll();
  });

  it('should start and fetch mempool transactions', async () => {
    mock.method(chainSource, 'getPendingTxIds', async () =>
      Promise.resolve(['tx1']),
    );
    mock.method(txFetcher, 'queueTxId', async () => Promise.resolve());

    mempoolWatcher.start();

    await wait(100);

    assert.deepEqual((chainSource.getPendingTxIds as any).mock.callCount(), 1);
    assert.deepEqual((txFetcher.queueTxId as any).mock.callCount(), 1);
    assert.deepEqual((txFetcher.queueTxId as any).mock.calls[0].arguments[0], {
      txId: 'tx1',
      isPendingTx: true,
    });
  });

  it('should handle errors when fetching mempool fails', async () => {
    mock.method(chainSource, 'getPendingTxIds', async () =>
      Promise.reject(new Error('Failed to fetch')),
    );
    mock.method(log, 'error');

    mempoolWatcher.start();

    await wait(100);

    assert.deepEqual(
      (log.error as any).mock.calls[0].arguments[0],
      'Failed to fetch mempool.',
    );
  });
});
