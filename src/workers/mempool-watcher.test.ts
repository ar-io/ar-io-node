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
import { strict as assert } from 'node:assert';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import winston from 'winston';
import { MempoolWatcher } from './mempool-watcher.js';
import { ArweaveChainSourceStub } from '../../test/stubs.js';
import { default as wait } from 'wait';

describe('MempoolWatcher', () => {
  let log: winston.Logger;
  let chainSource: ArweaveChainSourceStub;
  let txFetcher: any;
  let mempoolWatcher: MempoolWatcher;

  before(() => {
    log = winston.createLogger({ silent: true });
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
