/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { default as fastq } from 'fastq';
import type { queueAsPromised } from 'fastq';
import * as winston from 'winston';
import { DataImporter } from './data-importer.js';
import {
  ContiguousDataIndex,
  ContiguousDataSource,
  DataItemRootTxIndex,
  NormalizedDataItem,
  PartialJsonTransaction,
} from '../types.js';
import { DataRootComputer } from '../lib/data-root.js';
import * as config from '../config.js';

export type QueueBundleResponse = {
  status: 'skipped' | 'queued' | 'error';
  error?: string;
};

export class DataVerificationWorker {
  // Dependencies
  private log: winston.Logger;
  private contiguousDataIndex: ContiguousDataIndex;
  private dataItemRootTxIndex: DataItemRootTxIndex;
  private dataRootComputer: DataRootComputer;
  private dataImporter: DataImporter | undefined;
  private bundleDataImporter: DataImporter | undefined;
  private queueBundle:
    | ((
        item: NormalizedDataItem | PartialJsonTransaction,
        isPrioritized: boolean,
        bypassFilter: boolean,
      ) => Promise<QueueBundleResponse>)
    | undefined;

  private workerCount: number;
  private queue: queueAsPromised<string, void | boolean>;
  private interval: number;
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    contiguousDataIndex,
    dataItemRootTxIndex,
    contiguousDataSource,
    dataImporter,
    bundleDataImporter,
    queueBundle,
    workerCount = config.BACKGROUND_DATA_VERIFICATION_WORKER_COUNT,
    streamTimeout = config.BACKGROUND_DATA_VERIFICATION_STREAM_TIMEOUT_MS,
    interval = config.BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS * 1000,
  }: {
    log: winston.Logger;
    contiguousDataIndex: ContiguousDataIndex;
    dataItemRootTxIndex: DataItemRootTxIndex;
    contiguousDataSource: ContiguousDataSource;
    dataImporter?: DataImporter;
    bundleDataImporter?: DataImporter;
    queueBundle?: (
      item: NormalizedDataItem | PartialJsonTransaction,
      isPrioritized: boolean,
      bypassFilter: boolean,
    ) => Promise<QueueBundleResponse>;
    workerCount?: number;
    streamTimeout?: number;
    interval?: number;
  }) {
    this.log = log.child({ class: 'DataVerification' });
    this.contiguousDataIndex = contiguousDataIndex;
    this.dataItemRootTxIndex = dataItemRootTxIndex;
    this.workerCount = workerCount;
    this.interval = interval;
    this.queue = fastq.promise(
      this.verifyDataRoot.bind(this),
      Math.max(workerCount, 1),
    );
    this.dataRootComputer = new DataRootComputer({
      log,
      contiguousDataSource,
      workerCount,
      streamTimeout,
    });

    this.dataImporter = dataImporter;
    this.bundleDataImporter = bundleDataImporter;
    this.queueBundle = queueBundle;
  }

  async start(): Promise<void> {
    const log = this.log.child({ method: 'start' });

    log.info('Starting background data verification');

    await this.queueRootTx();
    this.intervalId = setInterval(this.queueRootTx.bind(this), this.interval);
  }

  async queueRootTx() {
    const log = this.log.child({ method: 'queueRootTx' });

    log.debug('Queueing data items for verification.');

    if (this.workerCount === 0) {
      log.warn('Skipping data item queuing due to no workers.');
      return;
    }

    const dataIds = await this.contiguousDataIndex.getVerifiableDataIds();
    const rootTxIds: string[] = [];

    for (const dataId of dataIds) {
      const rootTxId = await this.dataItemRootTxIndex.getRootTxId(dataId);

      if (rootTxId !== undefined && !rootTxIds.includes(rootTxId)) {
        rootTxIds.push(rootTxId);
      }
    }
    const queuedItems = this.queue.getQueue();
    for (const rootTxId of rootTxIds) {
      if (rootTxId !== undefined && !queuedItems.includes(rootTxId)) {
        log.debug('Queueing data ID for verification.', { id: rootTxId });
        this.queue.push(rootTxId);
      }
    }
  }

  async verifyDataRoot(id: string): Promise<boolean> {
    const log = this.log.child({ method: 'verifyDataRoot', id });
    try {
      const dataAttributes =
        await this.contiguousDataIndex.getDataAttributes(id);

      const indexedDataRoot = dataAttributes?.dataRoot;
      let computedDataRoot: string | undefined = undefined;
      if (indexedDataRoot === undefined) {
        log.verbose(
          'No indexed transaction data root found for ID. Skipping data root computation.',
        );

        // TODO: consider using bundle index to make this determination
        if (this.queueBundle && dataAttributes?.hash === undefined) {
          // Only queue bundle for verification if unbundling queue is empty
          const unbundlingQueueDepth =
            this.bundleDataImporter?.queueDepth() ?? 0;
          if (unbundlingQueueDepth === 0) {
            log.verbose('Root bundle has not been unbundled, queuing...');
            await this.queueBundle(
              { id, root_tx_id: id } as
                | NormalizedDataItem
                | PartialJsonTransaction,
              true,
              true,
            ); // isPrioritized: true, bypassFilter: true
          } else {
            log.debug('Skipping bundle queue due to busy unbundling system', {
              unbundlingQueueDepth,
            });
            return false;
          }
        } else {
          return false;
        }
      } else {
        log.verbose('Computing data root...');

        computedDataRoot = await this.dataRootComputer
          .computeDataRoot(id)
          .catch((error) => {
            log.debug('Error computing data root.', { error });
            return undefined;
          });
      }

      // TODO: consider how to handle downloaded, but never unbundled bundles
      if (
        indexedDataRoot === undefined ||
        indexedDataRoot !== computedDataRoot
      ) {
        log.verbose('Data root mismatch', {
          indexedDataRoot: indexedDataRoot ?? null,
          computedDataRoot: computedDataRoot ?? null,
        });

        if (this.dataImporter && indexedDataRoot !== undefined) {
          log.verbose(
            'Computed data root mismatch, queueing for root bundle download from chunks....',
          );
          await this.dataImporter.queueItem({ id }, true);
        }

        return false;
      }

      log.debug('Data root verified successfully.');
      await this.contiguousDataIndex.saveVerificationStatus(id);
      log.debug('Saved verified status successfully.');
      return true;
    } catch (error) {
      log.error('Error verifying data root', { error });
      return false;
    } finally {
      try {
        await this.contiguousDataIndex.incrementVerificationRetryCount(id);
      } catch (retryError) {
        log.error('Error incrementing retry count', { retryError });
      }
    }
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    clearInterval(this.intervalId);
    this.queue.kill();
    await this.dataRootComputer.stop();
    log.debug('Stopped successfully.');
  }
}
