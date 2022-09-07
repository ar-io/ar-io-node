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
import * as winston from 'winston';

import { ChainDatabase } from '../types.js';
import { TransactionFetcher } from './transaction-fetcher.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class TransactionRepairWorker {
  // Dependencies
  private log: winston.Logger;
  private chainDb: ChainDatabase;
  private txFetcher: TransactionFetcher;

  constructor({
    log,
    chainDb,
    txFetcher,
  }: {
    log: winston.Logger;
    chainDb: ChainDatabase;
    txFetcher: TransactionFetcher;
  }) {
    this.log = log.child({ class: 'TransactionRepairWorker' });
    this.chainDb = chainDb;
    this.txFetcher = txFetcher;
  }

  async start(): Promise<void> {
    setInterval(this.retryMissingTransactions.bind(this), DEFAULT_INTERVAL_MS);
  }

  async retryMissingTransactions() {
    try {
      const missingTxIds = await this.chainDb.getMissingTxIds();
      for (const txId of missingTxIds) {
        this.log.info('Retrying missing transaction', { txId });
        await this.txFetcher.queueTxId(txId);
      }
    } catch (error: any) {
      this.log.error('Error retrying missing transactions:', {
        message: error.message,
      });
    }
  }
}
