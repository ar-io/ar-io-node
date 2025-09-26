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
  private chunkDataImporter: DataImporter | undefined;
  private bundleDataImporter: DataImporter | undefined;
  private queueBundle:
    | ((
        item: NormalizedDataItem | PartialJsonTransaction,
        isPrioritized: boolean,
        bypassFilter: boolean,
      ) => Promise<QueueBundleResponse>)
    | undefined;

  private workerCount: number;
  private queue: queueAsPromised<
    { rootTxId: string; dataIds: string[] },
    void | boolean
  >;
  private interval: number;
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    contiguousDataIndex,
    dataItemRootTxIndex,
    contiguousDataSource,
    chunkDataImporter,
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
    chunkDataImporter?: DataImporter;
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
    this.log = log.child({ class: this.constructor.name });
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

    this.chunkDataImporter = chunkDataImporter;
    this.bundleDataImporter = bundleDataImporter;
    this.queueBundle = queueBundle;
  }

  async start(): Promise<void> {
    const log = this.log.child({ method: 'start' });

    log.info('Starting background data verification');

    await this.queueRootTxs();
    this.intervalId = setInterval(this.queueRootTxs.bind(this), this.interval);
  }

  async queueRootTxs() {
    const log = this.log.child({ method: 'queueRootTx' });

    log.debug('Queueing data items for verification.');

    if (this.workerCount === 0) {
      log.warn('Skipping data item queuing due to no workers.');
      return;
    }

    const dataIds = await this.contiguousDataIndex.getVerifiableDataIds();
    const rootTxToDataIds = new Map<string, Set<string>>();

    for (const dataId of dataIds) {
      const result = await this.dataItemRootTxIndex.getRootTxId(dataId);
      const rootTxId = result?.rootTxId;

      if (rootTxId !== undefined) {
        if (!rootTxToDataIds.has(rootTxId)) {
          rootTxToDataIds.set(rootTxId, new Set());
        }
        rootTxToDataIds.get(rootTxId)!.add(dataId);
      }
    }

    const queuedItems = this.queue.getQueue();
    for (const [rootTxId, dataIdSet] of rootTxToDataIds) {
      if (!queuedItems.some((item) => item.rootTxId === rootTxId)) {
        log.debug('Queueing data ID for verification.', { id: rootTxId });
        this.queue.push({
          rootTxId,
          dataIds: Array.from(dataIdSet),
        });
      }
    }
  }

  async verifyDataRoot({
    rootTxId,
    dataIds,
  }: {
    rootTxId: string;
    dataIds: string[];
  }): Promise<boolean> {
    const log = this.log.child({ method: 'verifyDataRoot', id: rootTxId });
    try {
      // TODO: use an implementation of contiguousDataIndex that attempts to
      // get 'data_root' from network sources (trusted Arweave nodes, gateways,
      // GQL) when it's unavailable in the local index
      const dataAttributes =
        await this.contiguousDataIndex.getDataAttributes(rootTxId);

      const indexedDataRoot = dataAttributes?.dataRoot;
      let computedDataRoot: string | undefined = undefined;
      if (indexedDataRoot === undefined) {
        log.verbose(
          'No indexed transaction data root found for ID. Skipping data root computation.',
        );

        // TODO: consider using bundle index to make unbundled determination

        // Queue bundle for unbundling if it has not already been unbundled
        if (this.queueBundle && dataAttributes?.hash === undefined) {
          // Only queue bundle for verification if unbundling queue is empty
          const unbundlingQueueDepth =
            this.bundleDataImporter?.queueDepth() ?? 0;
          if (unbundlingQueueDepth === 0) {
            log.verbose('Root bundle has not been unbundled, queuing...');
            await this.queueBundle(
              { id: rootTxId, root_tx_id: rootTxId } as
                | NormalizedDataItem
                | PartialJsonTransaction,
              true, // isPrioritized
              true, // bypassFilter
            );
          } else {
            log.verbose(
              'Skipping bundle queuing due to unbundling queue depth',
              {
                unbundlingQueueDepth,
              },
            );
            return false;
          }
        } else {
          return false;
        }
      } else {
        log.verbose('Computing data root...');

        computedDataRoot = await this.dataRootComputer
          .computeDataRoot(rootTxId)
          .catch((error) => {
            log.debug('Error computing data root.', { error });
            return undefined;
          });
      }

      // TODO: queue bundle for unbundling even if data roots match if bundle
      // index indicates it has not been unbundled (may be redundant if earlier
      // conditional is modified)
      if (
        indexedDataRoot === undefined ||
        indexedDataRoot !== computedDataRoot
      ) {
        log.verbose('Data root mismatch', {
          indexedDataRoot: indexedDataRoot ?? null,
          computedDataRoot: computedDataRoot ?? null,
        });

        if (this.chunkDataImporter && indexedDataRoot !== undefined) {
          log.verbose(
            'Computed data root mismatch, queueing for root bundle download from chunks....',
          );
          await this.chunkDataImporter.queueItem({ id: rootTxId }, true);
        }

        return false;
      }

      log.debug('Data root verified successfully.');
      await this.contiguousDataIndex.saveVerificationStatus(rootTxId);
      log.debug('Saved verified status successfully.');
      return true;
    } catch (error) {
      log.error('Error verifying data root', { error });
      return false;
    } finally {
      // Increment retry count for all associated data IDs
      for (const dataId of dataIds) {
        try {
          await this.contiguousDataIndex.incrementVerificationRetryCount(
            dataId,
          );
        } catch (retryError) {
          log.error('Error incrementing retry count', { dataId, retryError });
        }
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
