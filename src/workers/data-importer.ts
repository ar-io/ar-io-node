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

type AnyContiguousData = { id: string };
type UnbundleableItem = (NormalizedDataItem | PartialJsonTransaction) &
  IndexProperty;
type ImportableItem = AnyContiguousData | UnbundleableItem;

interface DataImporterQueueItem {
  item: ImportableItem;
  prioritized: boolean | undefined;
  bypassFilter: boolean;
}

export class DataImporter {
  // Dependencies
  private log: winston.Logger;
  private contiguousDataSource: ContiguousDataSource;
  private ans104Unbundler: Ans104Unbundler | undefined;

  // Contiguous data queue
  private workerCount: number;
  private maxQueueSize: number;
  private queue: queueAsPromised<DataImporterQueueItem, void>;

  constructor({
    log,
    contiguousDataSource,
    ans104Unbundler,
    workerCount,
    maxQueueSize = config.BUNDLE_DATA_IMPORTER_QUEUE_SIZE,
  }: {
    log: winston.Logger;
    contiguousDataSource: ContiguousDataSource;
    ans104Unbundler?: Ans104Unbundler;
    workerCount: number;
    maxQueueSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.contiguousDataSource = contiguousDataSource;
    if (ans104Unbundler) {
      this.ans104Unbundler = ans104Unbundler;
    }
    this.workerCount = workerCount;
    this.maxQueueSize = maxQueueSize;
    this.queue = fastq.promise(
      this.download.bind(this),
      Math.max(workerCount, 1), // fastq doesn't allow 0 workers
    );
  }

  async queueItem(
    item: ImportableItem,
    prioritized: boolean | undefined,
    bypassFilter = false,
  ): Promise<void> {
    const log = this.log.child({ method: 'queueItem', id: item.id });
    if (this.workerCount === 0) {
      log.debug('Skipping contiguous-data download, no workers.');
      return;
    }

    if (prioritized === true) {
      log.debug('Queueing prioritized contiguous data download...');
      this.queue.unshift({ item, prioritized, bypassFilter });
      log.debug('Prioritized contiguous data download queued.');
    } else if (this.queue.length() < this.maxQueueSize) {
      log.debug('Queueing contiguous data download...');
      this.queue.push({ item, prioritized, bypassFilter });
      log.debug('Contiguous data download queued.');
    } else {
      log.debug('Skipping contiguous data download, queue is full.');
    }
  }

  async download({
    item,
    prioritized,
    bypassFilter,
  }: DataImporterQueueItem): Promise<void> {
    const log = this.log.child({ method: 'download', id: item.id });

    const data = await this.contiguousDataSource.getData({ id: item.id });

    return new Promise((resolve, reject) => {
      data.stream.on('end', () => {
        const isUnbundleableItem = this.isUnbundleableItem(item);
        if (this.ans104Unbundler && isUnbundleableItem) {
          log.debug('Data download completed. Queuing for unbundling...');
          this.ans104Unbundler.queueItem(item, prioritized, bypassFilter);
        } else {
          log.debug(
            isUnbundleableItem
              ? 'Data download completed, skipping unbundling because unbundler is not available'
              : 'Data download completed, marked as any contiguous tx/data-item, skipping unbundling',
          );
        }
        resolve();
      });

      data.stream.on('error', (error) => {
        log.error('Error downloading data.', {
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
    log.debug('Stopped successfully.');
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async isQueueFull(): Promise<boolean> {
    return this.queue.length() >= this.maxQueueSize;
  }

  isUnbundleableItem(item: ImportableItem): item is UnbundleableItem {
    return Object.keys(item).length > 1 && 'index' in item;
  }
}
