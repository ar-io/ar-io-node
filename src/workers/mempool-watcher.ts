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
import { ArweaveCompositeClient } from '../arweave/composite-client.js';
import { TransactionFetcher } from './transaction-fetcher.js';

export class MempoolWatcher {
  // Dependencies
  private log: winston.Logger;
  private arweaveClient: ArweaveCompositeClient;
  private txFetcher: TransactionFetcher;

  // Parameters
  private mempoolPoolingIntervalMs: number;

  // State
  private shouldRun: boolean;
  private pendingTxs: Map<string, boolean> = new Map();

  constructor({
    log,
    arweaveClient,
    txFetcher,
    mempoolPoolingIntervalMs,
  }: {
    log: winston.Logger;
    arweaveClient: ArweaveCompositeClient;
    txFetcher: TransactionFetcher;
    mempoolPoolingIntervalMs: number;
  }) {
    this.log = log.child({ class: 'MempoolWatcher' });
    this.arweaveClient = arweaveClient;
    this.txFetcher = txFetcher;
    this.mempoolPoolingIntervalMs = mempoolPoolingIntervalMs;
    this.shouldRun = false;
  }

  private normalizePendingTxs(txs: string[]): void {
    const mempoolTxs = new Set(txs);
    // Remove items from the pendingTxs that aren't in the mempool and were already fetched
    for (const [key, value] of this.pendingTxs) {
      if (!mempoolTxs.has(key) && value === true) {
        this.pendingTxs.delete(key);
      }
    }

    // Add items from the mempool to the pendingTxs if they are not already there
    for (const item of mempoolTxs) {
      if (!this.pendingTxs.has(item)) {
        this.pendingTxs.set(item, false);
      }
    }
  }

  public async start(): Promise<void> {
    this.shouldRun = true;

    // Run until stop is called
    while (this.shouldRun) {
      this.log.info('Fetching mempool...');
      try {
        const pendingTxsList = await this.arweaveClient.getPendingTxIds();

        this.normalizePendingTxs(pendingTxsList);

        for (const [key, value] of this.pendingTxs) {
          if (value === false) {
            this.txFetcher.queueTxId({ txId: key, isPendingTx: true });
            this.pendingTxs.set(key, true);
          }
        }

        this.log.info('Mempool fetched successfully.');
      } catch (err) {
        this.log.error('Failed to fetch mempool.', err);
      }

      await wait(this.mempoolPoolingIntervalMs);
    }
  }

  public async stop(): Promise<void> {
    this.shouldRun = false;
    this.pendingTxs.clear();
  }
}
