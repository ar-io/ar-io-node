/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as EventEmitter from 'node:events';
import { default as wait } from 'wait';
import * as winston from 'winston';

import * as events from '../events.js';
import { ChainSource, PartialJsonTransaction } from '../types.js';

const DEFAULT_WORKER_COUNT = 1;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_WAIT_MS = 5000;

export class TransactionFetcher {
  // Dependencies
  private log: winston.Logger;
  private chainSource: ChainSource;
  private eventEmitter: EventEmitter;

  // Parameters
  private maxAttempts: number;
  private retryWaitMs: number;

  // TX fetch queue
  private queue: queueAsPromised<{ txId: string; isPendingTx?: boolean }, void>;

  constructor({
    log,
    chainSource,
    eventEmitter,
    workerCount = DEFAULT_WORKER_COUNT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryWaitMs = DEFAULT_RETRY_WAIT_MS,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    eventEmitter: EventEmitter;
    workerCount?: number;
    maxAttempts?: number;
    retryWaitMs?: number;
  }) {
    this.log = log.child({ class: 'TransactionFetcher' });
    this.chainSource = chainSource;
    this.eventEmitter = eventEmitter;

    this.maxAttempts = maxAttempts;
    this.retryWaitMs = retryWaitMs;

    // Initialize TX ID fetch queue
    this.queue = fastq.promise(this.fetchTx.bind(this), workerCount);
  }

  async queueTxId({
    txId,
    isPendingTx = false,
  }: {
    txId: string;
    isPendingTx?: boolean;
  }): Promise<void> {
    const log = this.log.child({ method: 'queueTxId', txId });
    log.info('Queuing transaction...');

    const queuedItems = this.queue.getQueue();
    if (queuedItems.some((item) => item.txId === txId)) {
      log.info('Transaction already queued.');
      return;
    }

    this.queue.push({ txId, isPendingTx });
    log.info('Transaction queued.');
  }

  async fetchTx({
    txId,
    isPendingTx = false,
  }: {
    txId: string;
    isPendingTx?: boolean;
  }): Promise<void> {
    const log = this.log.child({ txId });

    let attempts = 0;
    let tx: PartialJsonTransaction | undefined;
    while (attempts < this.maxAttempts && !tx) {
      try {
        log.info('Fetching transaction...');
        tx = await this.chainSource.getTx({ txId, isPendingTx });
        this.eventEmitter.emit(events.TX_FETCHED, tx);
        log.info('Transaction fetched.');
      } catch (error: any) {
        log.warn('Failed to fetch transaction:', {
          message: error?.message,
          stack: error?.stack,
        });
        await wait(this.retryWaitMs);
        attempts++;
      }
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
