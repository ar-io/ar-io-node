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
  private queueBundle:
    | ((options: {
        item: NormalizedDataItem | PartialJsonTransaction;
        prioritized?: boolean;
        bypassBundleFilter?: boolean;
        bypassDataItemFilter?: boolean;
      }) => Promise<QueueBundleResponse>)
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
    queueBundle?: (options: {
      item: NormalizedDataItem | PartialJsonTransaction;
      prioritized?: boolean;
      bypassBundleFilter?: boolean;
      bypassDataItemFilter?: boolean;
    }) => Promise<QueueBundleResponse>;
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
          log.verbose('Root bundle has not been unbundled, queuing...');
          await this.queueBundle({
            item: { id, root_tx_id: id } as
              | NormalizedDataItem
              | PartialJsonTransaction,
            prioritized: true,
            bypassBundleFilter: true,
          });
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
          await this.dataImporter.queueItem({
            item: { id },
            prioritized: true,
          });
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
