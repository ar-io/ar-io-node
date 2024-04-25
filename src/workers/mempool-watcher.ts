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
import { default as wait } from 'wait';
import * as winston from 'winston';
import { ChainSource } from '../types.js';
import { TransactionFetcher } from './transaction-fetcher.js';

enum TxState {
  Pending,
  Fetched,
}
export class MempoolWatcher {
  // Dependencies
  private log: winston.Logger;
  private chainSource: ChainSource;
  private txFetcher: TransactionFetcher;

  // Parameters
  private mempoolPollingIntervalMs: number;

  // State
  private shouldRun: boolean;
  private pendingTxs: Map<string, TxState> = new Map();

  constructor({
    log,
    chainSource,
    txFetcher,
    mempoolPollingIntervalMs,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    txFetcher: TransactionFetcher;
    mempoolPollingIntervalMs: number;
  }) {
    this.log = log.child({ class: 'MempoolWatcher' });
    this.chainSource = chainSource;
    this.txFetcher = txFetcher;
    this.mempoolPollingIntervalMs = mempoolPollingIntervalMs;
    this.shouldRun = false;
  }

  private normalizePendingTxs(mempoolTxs: string[]): void {
    // Remove items from the pendingTxs that aren't in the mempool and were already fetched
    for (const [key, value] of this.pendingTxs) {
      if (!mempoolTxs.includes(key) && value === TxState.Fetched) {
        this.pendingTxs.delete(key);
      }
    }

    // Add items from the mempool to the pendingTxs if they are not already there
    for (const item of mempoolTxs) {
      if (!this.pendingTxs.has(item)) {
        this.pendingTxs.set(item, TxState.Pending);
      }
    }
  }

  public async start(): Promise<void> {
    this.shouldRun = true;

    // Run until stop is called
    while (this.shouldRun) {
      this.log.info('Fetching mempool...');
      try {
        const pendingTxsList = await this.chainSource.getPendingTxIds();

        this.normalizePendingTxs(pendingTxsList);

        for (const [key, value] of this.pendingTxs) {
          if (value === TxState.Pending) {
            this.txFetcher.queueTxId({ txId: key, isPendingTx: true });
            this.pendingTxs.set(key, TxState.Fetched);
          }
        }

        this.log.info('Mempool fetched successfully.');
      } catch (err) {
        this.log.error('Failed to fetch mempool.', err);
      }

      await wait(this.mempoolPollingIntervalMs);
    }
  }

  public async stop(): Promise<void> {
    this.shouldRun = false;
    this.pendingTxs.clear();
  }
}
