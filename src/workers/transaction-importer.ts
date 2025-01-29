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
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as EventEmitter from 'node:events';
import * as winston from 'winston';

import * as events from '../events.js';
import { ChainIndex, PartialJsonTransaction } from '../types.js';

const DEFAULT_WORKER_COUNT = 1;

export class TransactionImporter {
  // Dependencies
  private log: winston.Logger;
  private chainIndex: ChainIndex;
  private eventEmitter: EventEmitter;

  // TX import queue
  private queue: queueAsPromised<PartialJsonTransaction, void>;

  constructor({
    log,
    chainIndex,
    eventEmitter,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    chainIndex: ChainIndex;
    eventEmitter: EventEmitter;
    workerCount?: number;
  }) {
    this.log = log.child({ class: 'TransactionImporter' });
    this.eventEmitter = eventEmitter;
    this.chainIndex = chainIndex;

    // Initialize TX import queue
    this.queue = fastq.promise(this.importTx.bind(this), workerCount);
  }

  async queueTx(tx: PartialJsonTransaction): Promise<void> {
    const log = this.log.child({ method: 'queueTx', txId: tx.id });
    log.debug('Queuing transaction...');
    this.queue.push(tx);
    log.debug('Transaction queued.');
  }

  async importTx(tx: PartialJsonTransaction): Promise<void> {
    const log = this.log.child({ txId: tx.id });
    try {
      log.info('Importing transaction...');
      await this.chainIndex.saveTx(tx);
      log.info('Transaction imported.');
      this.eventEmitter.emit(events.TX_INDEXED, tx);
    } catch (error: any) {
      log.error('Failed to import transaction:', error);
    }
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    log.debug('Stopped successfully.');
  }

  queueDepth(): number {
    return this.queue.length();
  }
}
