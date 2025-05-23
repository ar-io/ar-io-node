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
import { ContiguousDataIndex, ContiguousDataSource } from '../types.js';
import { DataRootComputer } from '../lib/data-root.js';
import * as config from '../config.js';

export class DataVerificationWorker {
  // Dependencies
  private log: winston.Logger;
  private contiguousDataIndex: ContiguousDataIndex;
  private dataRootComputer: DataRootComputer;
  private dataImporter: DataImporter | undefined;

  private workerCount: number;
  private queue: queueAsPromised<string, void | boolean>;
  private interval: number;
  private intervalId?: NodeJS.Timeout;

  constructor({
    log,
    contiguousDataIndex,
    contiguousDataSource,
    dataImporter,
    workerCount = config.BACKGROUND_DATA_VERIFICATION_WORKER_COUNT,
    streamTimeout = config.BACKGROUND_DATA_VERIFICATION_STREAM_TIMEOUT_MS,
    interval = config.BACKGROUND_DATA_VERIFICATION_INTERVAL_SECONDS * 1000,
  }: {
    log: winston.Logger;
    contiguousDataIndex: ContiguousDataIndex;
    contiguousDataSource: ContiguousDataSource;
    dataImporter?: DataImporter;
    workerCount?: number;
    streamTimeout?: number;
    interval?: number;
  }) {
    this.log = log.child({ class: 'DataVerification' });
    this.contiguousDataIndex = contiguousDataIndex;
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
      const rootTxId = await this.contiguousDataIndex.getRootTxId(dataId);

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

      if (dataAttributes === undefined) {
        log.warn('Data attributes not found.');
        return false;
      }

      if (dataAttributes.dataRoot === undefined) {
        log.warn(
          'Data root not found for id. Transaction must be indexed before it can be verified.',
        );
        return false;
      }

      const indexedDataRoot = dataAttributes.dataRoot;

      const computedDataRoot: string | undefined = await this.dataRootComputer
        .computeDataRoot(id)
        .catch((error) => {
          log.debug('Error computing data root.', { error });
          return undefined;
        });

      if (
        computedDataRoot === undefined ||
        indexedDataRoot !== computedDataRoot
      ) {
        log.error('Data root mismatch', {
          indexedDataRoot,
          computedDataRoot,
        });
        if (this.dataImporter) {
          log.debug(
            'Because of data-root mismatch, we are queueing data item for reimport.',
            { id },
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
