/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
