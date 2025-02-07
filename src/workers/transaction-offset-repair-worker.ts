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

import { ChainOffsetIndex } from '../types.js';
import { TransactionOffsetImporter } from './transaction-offset-importer.js';

const DEFAULT_TXS_PER_BATCH = 1000;
const DEFAULT_INTERVAL_MS = 10 * 1000;

export class TransactionOffsetRepairWorker {
  // Dependencies
  private log: winston.Logger;
  private chainOffsetIndex: ChainOffsetIndex;
  private txOffsetIndexer: TransactionOffsetImporter;
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    chainOffsetIndex,
    txOffsetIndexer,
  }: {
    log: winston.Logger;
    chainOffsetIndex: ChainOffsetIndex;
    txOffsetIndexer: TransactionOffsetImporter;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chainOffsetIndex = chainOffsetIndex;
    this.txOffsetIndexer = txOffsetIndexer;
  }

  async start(): Promise<void> {
    this.fetchMissingOffsets();
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    log.debug('Stopped successfully.');
  }

  async fetchMissingOffsets() {
    try {
      const txIds = await this.chainOffsetIndex.getTxIdsMissingOffsets(
        DEFAULT_TXS_PER_BATCH,
      );
      for (const txId of txIds) {
        this.log.debug('Queueing missing transaction for offset indexing...');
        await this.txOffsetIndexer.queueTxId(txId);
        this.log.debug('Queued missing transaction for offset indexing.');
      }
    } catch (error: any) {
      this.log.error('Error retrying missing transactions:', error);
    }

    this.intervalId = setTimeout(
      this.fetchMissingOffsets.bind(this),
      DEFAULT_INTERVAL_MS,
    );
  }
}
