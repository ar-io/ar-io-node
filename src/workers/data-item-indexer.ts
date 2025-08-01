/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
      metrics.dataItemsIndexedCounter.inc({
        parent_type:
          item.parent_id === item.root_tx_id ? 'transaction' : 'data_item',
      });
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
    log.debug('Stopped successfully.');
  }
}
