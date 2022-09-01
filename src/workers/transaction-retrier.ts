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
import * as EventEmitter from 'events';
import * as winston from 'winston';

import { ChainDatabase } from '../types.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class TransactionRetrier {
  // Dependencies
  private log: winston.Logger;
  private chainDb: ChainDatabase;
  private eventEmitter: EventEmitter;

  constructor({
    log,
    chainDb,
    eventEmitter,
  }: {
    log: winston.Logger;
    chainDb: ChainDatabase;
    eventEmitter: EventEmitter;
  }) {
    this.log = log.child({ worker: 'transaction-retrier' });
    this.eventEmitter = eventEmitter;
    this.chainDb = chainDb;
  }

  async start(): Promise<void> {
    setInterval(this.retryMissingTransactions.bind(this), DEFAULT_INTERVAL_MS);
  }

  async retryMissingTransactions() {
    try {
      const missingTxIds = await this.chainDb.getMissingTxIds();
      for (const txId of missingTxIds) {
        this.log.info(`Retrying missing transaction`, { txId });
        // FIXME temporary hack to wire this to the transaction fetcher
        this.eventEmitter.emit('block-tx-fetch-failed', txId);
      }
    } catch (error) {
      this.log.error(`Error retrying missing transactions: ${error}`);
    }
  }
}
