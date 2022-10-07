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
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as winston from 'winston';

import { ChainDatabase, PartialJsonTransaction } from '../types.js';

const DEFAULT_WORKER_COUNT = 1;

export class TransactionImporter {
  // Dependencies
  private log: winston.Logger;
  private chainDb: ChainDatabase;
  private eventEmitter: EventEmitter;

  // TX fetch queue
  private txImportQueue: queueAsPromised<PartialJsonTransaction, void>;

  constructor({
    log,
    chainDb,
    eventEmitter,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    chainDb: ChainDatabase;
    eventEmitter: EventEmitter;
    workerCount?: number;
  }) {
    this.log = log.child({ class: 'TransactionImporter' });
    this.eventEmitter = eventEmitter;
    this.chainDb = chainDb;

    // Initialize TX import queue
    this.txImportQueue = fastq.promise(this.importTx.bind(this), workerCount);
  }

  async queueTx(tx: PartialJsonTransaction): Promise<void> {
    this.log.info('Queuing transaction to import', { txId: tx.id });
    this.txImportQueue.push(tx);
  }

  async importTx(tx: PartialJsonTransaction): Promise<void> {
    const log = this.log.child({ txId: tx.id });
    try {
      log.info('Importing transaction');
      await this.chainDb.saveTx(tx);
      this.eventEmitter.emit('tx-saved', tx);
    } catch (error: any) {
      log.error('Failed to import transaction:', error);
    }
  }
}
