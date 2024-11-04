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
import * as EventEmitter from 'node:events';
import * as winston from 'winston';
import * as metrics from '../metrics.js';

import * as events from '../events.js';
import { DataItemIndexWriter, NormalizedDataItem } from '../types.js';

const DEFAULT_WORKER_COUNT = 1;

export class DataItemIndexer {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private indexWriter: DataItemIndexWriter;

  // Data indexing queue
  private queue: queueAsPromised<NormalizedDataItem, void>;

  constructor({
    log,
    eventEmitter,
    indexWriter,
    workerCount = DEFAULT_WORKER_COUNT,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    indexWriter: DataItemIndexWriter;
    workerCount?: number;
  }) {
    this.log = log.child({ class: 'DataItemIndexer' });
    this.indexWriter = indexWriter;
    this.eventEmitter = eventEmitter;

    this.queue = fastq.promise(this.indexDataItem.bind(this), workerCount);
  }

  async queueDataItem(
    item: NormalizedDataItem,
    isPrioritized = false,
  ): Promise<void> {
    const log = this.log.child({
      method: 'queueDataItem',
      id: item.id,
      parentId: item.parent_id,
      rootTxId: item.root_tx_id,
    });

    if (isPrioritized) {
      log.debug('Queueing prioritized data item for indexing...');
      this.queue.unshift(item);
      log.debug('Prioritized data item queued for indexing.');
    } else {
      log.debug('Queueing data item for indexing...');
      this.queue.push(item);
      log.debug('Data item queued for indexing.');
    }
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async indexDataItem(item: NormalizedDataItem): Promise<void> {
    const log = this.log.child({
      method: 'indexDataItem',
      id: item.id,
      parentId: item.parent_id,
      rootTxId: item.root_tx_id,
    });

    try {
      log.debug('Indexing data item...');
      await this.indexWriter.saveDataItem(item);
      metrics.dataItemsIndexedCounter.inc();
      metrics.dataItemLastIndexedTimestampSeconds.set(
        Math.floor(Date.now() / 1000),
      );
      this.eventEmitter.emit(events.ANS104_DATA_ITEM_INDEXED, item);
      log.debug('Data item indexed.');
    } catch (error) {
      log.error('Failed to index data item data:', error);
    }
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    await this.queue.drained();
    log.debug('Stopped successfully.');
  }
}
