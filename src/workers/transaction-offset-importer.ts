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
import * as winston from 'winston';

import { ChainOffsetIndex, ChainSource } from '../types.js';

const DEFAULT_WORKER_COUNT = 10;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

export class TransactionOffsetImporter {
  // Dependencies
  private log: winston.Logger;
  private chainSource: ChainSource;
  private chainOffsetIndex: ChainOffsetIndex;
  private maxQueueSize: number;
  private inprogressTxIds = new Set<string>();

  // TX fetch queue
  private queue: queueAsPromised<string, void>;

  constructor({
    log,
    chainSource,
    chainOffsetIndex,
    workerCount = DEFAULT_WORKER_COUNT,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    chainOffsetIndex: ChainOffsetIndex;
    workerCount?: number;
    maxQueueSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chainSource = chainSource;
    this.chainOffsetIndex = chainOffsetIndex;
    this.maxQueueSize = maxQueueSize;

    // Initialize TX ID fetch queue
    this.queue = fastq.promise(this.indexTxOffset.bind(this), workerCount);
  }

  async queueTxId(txId: string): Promise<void> {
    const log = this.log.child({ method: 'queueTxId', txId });
    if (this.inprogressTxIds.has(txId)) {
      log.debug('Skipping offset indexing, already in progress.');
    } else if (this.queue.length() >= this.maxQueueSize) {
      log.debug('Skipping offset indexing, queue is full.');
    } else {
      this.inprogressTxIds.add(txId);
      log.debug('Queueing transaction for offset indexing...');
      this.queue.push(txId);
      log.debug('Transaction queued for offset indexing.');
    }
  }

  async indexTxOffset(txId: string): Promise<void> {
    const log = this.log.child({ txId });
    try {
      log.debug('Fetching transaction offset...');
      const { offset } = await this.chainSource.getTxOffset(txId);
      log.debug('Transaction offset fetched.');

      log.debug('Saving transaction offset...');
      await this.chainOffsetIndex.saveTxOffset(txId, offset);
      log.debug('Transaction offset saved.');
    } catch (error: any) {
      log.warn('Failed to fetch transaction offset:', {
        message: error?.message,
        stack: error?.stack,
      });
    }
    this.inprogressTxIds.delete(txId);
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
