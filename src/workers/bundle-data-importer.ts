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

import { Ans104Unbundler } from './ans104-unbundler.js';
import {
  ContiguousDataSource,
  NormalizedDataItem,
  PartialJsonTransaction,
} from '../types.js';
import * as config from '../config.js';

interface IndexProperty {
  index: number;
}

type UnbundleableItem = (NormalizedDataItem | PartialJsonTransaction) &
  IndexProperty;

interface UnbundlingQueueItem {
  item: UnbundleableItem;
  prioritized: boolean | undefined;
  bypassFilter: boolean;
}

export class BundleDataImporter {
  // Dependencies
  private log: winston.Logger;
  private contiguousDataSource: ContiguousDataSource;
  private ans104Unbundler: Ans104Unbundler;

  // Unbundling queue
  private workerCount: number;
  private maxQueueSize: number;
  private queue: queueAsPromised<UnbundlingQueueItem, void>;

  constructor({
    log,
    contiguousDataSource,
    ans104Unbundler,
    workerCount,
    maxQueueSize = config.BUNDLE_DATA_IMPORTER_QUEUE_SIZE,
  }: {
    log: winston.Logger;
    contiguousDataSource: ContiguousDataSource;
    ans104Unbundler: Ans104Unbundler;
    workerCount: number;
    maxQueueSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.contiguousDataSource = contiguousDataSource;
    this.ans104Unbundler = ans104Unbundler;
    this.workerCount = workerCount;
    this.maxQueueSize = maxQueueSize;
    this.queue = fastq.promise(
      this.download.bind(this),
      Math.max(workerCount, 1), // fastq doesn't allow 0 workers
    );
  }

  async queueItem(
    item: UnbundleableItem,
    prioritized: boolean | undefined,
    bypassFilter = false,
  ): Promise<void> {
    const log = this.log.child({ method: 'queueItem', id: item.id });
    if (this.workerCount === 0) {
      log.debug('Skipping bundle download, no workers.');
      return;
    }

    if (prioritized === true) {
      log.debug('Queueing prioritized bundle download...');
      this.queue.unshift({ item, prioritized, bypassFilter });
      log.debug('Prioritized bundle download queued.');
    } else if (this.queue.length() < this.maxQueueSize) {
      log.debug('Queueing bundle download...');
      this.queue.push({ item, prioritized, bypassFilter });
      log.debug('Bundle download queued.');
    } else {
      log.debug('Skipping bundle download, queue is full.');
    }
  }

  async download({
    item,
    prioritized,
    bypassFilter,
  }: UnbundlingQueueItem): Promise<void> {
    const log = this.log.child({ method: 'download', id: item.id });

    const data = await this.contiguousDataSource.getData({ id: item.id });

    return new Promise((resolve, reject) => {
      data.stream.on('end', () => {
        log.debug('Bundle data downloaded complete. Queuing for unbundling..');
        this.ans104Unbundler.queueItem(item, prioritized, bypassFilter);
        resolve();
      });

      data.stream.on('error', (error) => {
        log.error('Error downloading bundle data.', {
          message: error.message,
          stack: error.stack,
        });
        reject(error);
      });

      data.stream.resume();
    });
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    await this.queue.drained();
    log.debug('Stopped successfully.');
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async isQueueFull(): Promise<boolean> {
    return this.queue.length() >= this.maxQueueSize;
  }
}
