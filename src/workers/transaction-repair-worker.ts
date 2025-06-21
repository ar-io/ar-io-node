/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as winston from 'winston';

import { ChainIndex } from '../types.js';
import { TransactionFetcher } from './transaction-fetcher.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TXS_TO_RETRY = 20;

export class TransactionRepairWorker {
  // Dependencies
  private log: winston.Logger;
  private chainIndex: ChainIndex;
  private txFetcher: TransactionFetcher;
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    chainIndex,
    txFetcher,
  }: {
    log: winston.Logger;
    chainIndex: ChainIndex;
    txFetcher: TransactionFetcher;
  }) {
    this.log = log.child({ class: 'TransactionRepairWorker' });
    this.chainIndex = chainIndex;
    this.txFetcher = txFetcher;
  }

  async start(): Promise<void> {
    this.intervalId = setInterval(
      this.retryMissingTransactions.bind(this),
      DEFAULT_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });

    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    log.debug('Stopped successfully.');
  }

  async retryMissingTransactions() {
    try {
      const missingTxIds =
        await this.chainIndex.getMissingTxIds(DEFAULT_TXS_TO_RETRY);
      for (const txId of missingTxIds) {
        this.log.info('Retrying missing transaction', { txId });
        await this.txFetcher.queueTxId({ txId });
      }
    } catch (error: any) {
      this.log.error('Error retrying missing transactions:', error);
    }
  }
}
