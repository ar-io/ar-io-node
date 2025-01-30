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
import * as winston from 'winston';

import { ChainIndex } from '../types.js';
import { TransactionFetcher } from './transaction-fetcher.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TXS_TO_RETRY = 20;

export class TransactionRepairWorker {
  // Dependencies
  private log: winston.Logger;
  private chainIndex: ChainIndex;
  private txFetcher: TransactionFetcher;
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    chainIndex,
    txFetcher,
  }: {
    log: winston.Logger;
    chainIndex: ChainIndex;
    txFetcher: TransactionFetcher;
  }) {
    this.log = log.child({ class: 'TransactionRepairWorker' });
    this.chainIndex = chainIndex;
    this.txFetcher = txFetcher;
  }

  async start(): Promise<void> {
    this.intervalId = setInterval(
      this.retryMissingTransactions.bind(this),
      DEFAULT_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    log.debug('Stopped successfully.');
  }

  async retryMissingTransactions() {
    try {
      const missingTxIds =
        await this.chainIndex.getMissingTxIds(DEFAULT_TXS_TO_RETRY);
      for (const txId of missingTxIds) {
        this.log.info('Retrying missing transaction', { txId });
        await this.txFetcher.queueTxId({ txId });
      }
    } catch (error: any) {
      this.log.error('Error retrying missing transactions:', error);
    }
  }
}
