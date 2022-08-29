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
    importEvents,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    chainDb: ChainDatabase;
    eventEmitter: EventEmitter;
    importEvents: string[];
    workerCount?: number;
  }) {
    this.log = log.child({ worker: 'transaction-importer' });
    this.eventEmitter = eventEmitter;
    this.chainDb = chainDb;

    for (const event of importEvents) {
      this.eventEmitter.addListener(event, this.queueTx.bind(this));
    }

    // Initialize TX import queue
    this.txImportQueue = fastq.promise(this.importTx.bind(this), workerCount);
  }

  async importTx(tx: PartialJsonTransaction): Promise<void> {
    const txId = tx.id;
    try {
      this.log.info(`Importing TX ${txId}`, { txId });
      await this.chainDb.saveTx(tx);
      this.eventEmitter.emit('tx-imported', tx);
    } catch (error) {
      this.log.error(`Failed to import TX ${txId}`, { txId, error });
    }
  }

  async queueTx(tx: PartialJsonTransaction): Promise<void> {
    const txId = tx.id;
    this.log.info(`Queuing TX ${txId} for import`, { txId });
    this.txImportQueue.push(tx);
  }
}
