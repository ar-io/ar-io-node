/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
