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
const DEFAULT_MAX_QUEUE_SIZE = 500_000;
const QUEUE_NAME = 'dataItemIndexer';

interface DataItemJob {
  item: NormalizedDataItem;
  isOptimistic: boolean;
}

export class DataItemIndexer {
  // Dependencies
  private log: winston.Logger;
  private eventEmitter: EventEmitter;
  private indexWriter: DataItemIndexWriter;

  // Backpressure: hard cap on queue depth. `0` disables the cap.
  // Prioritized pushes (e.g. admin POSTs) bypass the cap; non-prioritized
  // pushes that arrive at the cap are dropped and counted in
  // `data_items_dropped_total{queue_name="dataItemIndexer"}`. The bundle
  // record's `last_fully_indexed_at` will stay NULL for any dropped item,
  // so `bundle-repair-worker` is the recovery path.
  private maxQueueSize: number;

  // Data indexing queue
  private queue: queueAsPromised<DataItemJob, void>;

  // Tracked queue depth. Mirrors `this.queue.length()` but is O(1) to read.
  // fastq's `length()` walks the linked list of pending tasks, which is
  // O(n) — at 100k+ depth that single call dominates main-thread CPU
  // (PE-9089: ~7-15ms per push, scaling with depth, was the actual
  // throughput-killer once the backpressure check was added in PE-9086).
  // We increment when a job is queued and decrement in `indexDataItem`'s
  // `finally` so the counter stays accurate even on worker errors.
  private depth = 0;

  constructor({
    log,
    eventEmitter,
    indexWriter,
    workerCount = DEFAULT_WORKER_COUNT,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    indexWriter: DataItemIndexWriter;
    workerCount?: number;
    maxQueueSize?: number;
  }) {
    this.log = log.child({ class: 'DataItemIndexer' });
    this.indexWriter = indexWriter;
    this.eventEmitter = eventEmitter;
    this.maxQueueSize = maxQueueSize;

    this.queue = fastq.promise(this.indexDataItem.bind(this), workerCount);
  }

  async queueDataItem(
    item: NormalizedDataItem,
    isPrioritized = false,
    isOptimistic = false,
  ): Promise<void> {
    // Hot path under bundle ingest. Avoid `this.log.child(...)` here:
    // winston's child() allocates a new logger and merges metadata,
    // which dominates main-thread CPU at 5k+ items/sec (PE-9089
    // profile attributed ~99% of self-time to this method's body
    // largely via the child-logger creation). Share a meta object
    // across the debug/warn sites instead — same observability,
    // ~20× cheaper per call.
    const meta = {
      method: 'queueDataItem',
      id: item.id,
      parentId: item.parent_id,
      rootTxId: item.root_tx_id,
      isOptimistic,
    };

    const job: DataItemJob = { item, isOptimistic };

    if (isPrioritized) {
      this.log.debug('Queueing prioritized data item for indexing...', meta);
      this.queue.unshift(job);
      this.depth++;
      this.log.debug('Prioritized data item queued for indexing.', meta);
    } else if (this.maxQueueSize === 0 || this.depth < this.maxQueueSize) {
      this.log.debug('Queueing data item for indexing...', meta);
      this.queue.push(job);
      this.depth++;
      this.log.debug('Data item queued for indexing.', meta);
    } else {
      metrics.dataItemsDroppedCounter.inc({ queue_name: QUEUE_NAME });
      this.log.warn('Dropping data item — queue is at maxQueueSize.', {
        ...meta,
        queueDepth: this.depth,
        maxQueueSize: this.maxQueueSize,
      });
    }
  }

  queueDepth(): number {
    return this.depth;
  }

  async indexDataItem(job: DataItemJob): Promise<void> {
    const { item, isOptimistic } = job;
    const log = this.log.child({
      method: 'indexDataItem',
      id: item.id,
      parentId: item.parent_id,
      rootTxId: item.root_tx_id,
      isOptimistic,
    });

    try {
      log.debug('Indexing data item...');
      await this.indexWriter.saveDataItem(item, isOptimistic);
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
    } finally {
      this.depth--;
    }
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    log.debug('Stopped successfully.');
  }
}
