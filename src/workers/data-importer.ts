/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
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
import * as metrics from '../metrics.js';

interface IndexProperty {
  index: number;
}

type AnyContiguousData = { id: string };
// We can only unbundle items with indexes, and they can be either data items or transactions
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
  private name: string;
  private workerCount: number;
  private maxQueueSize: number;
  private queue: queueAsPromised<DataImporterQueueItem, void>;

  constructor({
    log,
    name = 'default',
    contiguousDataSource,
    ans104Unbundler,
    workerCount,
    maxQueueSize = config.BUNDLE_DATA_IMPORTER_QUEUE_SIZE,
  }: {
    log: winston.Logger;
    name?: string;
    contiguousDataSource: ContiguousDataSource;
    ans104Unbundler?: Ans104Unbundler;
    workerCount: number;
    maxQueueSize?: number;
  }) {
    this.name = name;
    this.log = log.child({ class: this.constructor.name, importer: name });
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
      metrics.dataImporterQueueFullSkipsCounter.inc({ importer: this.name });
      log.debug('Skipping contiguous data download, queue is full.');
    }
  }

  async download({
    item,
    prioritized,
    bypassFilter,
  }: DataImporterQueueItem): Promise<void> {
    const log = this.log.child({ method: 'download', id: item.id });
    const startMs = Date.now();

    const data = await this.contiguousDataSource.getData({ id: item.id });
    const size = data.size;

    return new Promise((resolve, reject) => {
      data.stream.on('end', () => {
        const elapsedMs = Date.now() - startMs;
        metrics.bundleDownloadDurationSeconds.observe(
          { outcome: 'success' },
          elapsedMs / 1000,
        );
        metrics.bundleDownloadSizeBytes.observe({ outcome: 'success' }, size);
        const hasIndexProperty = this.hasIndexPropery(item);
        log.info('Bundle download completed', {
          elapsedMs,
          size,
          cached: data.cached,
          willUnbundle: this.ans104Unbundler !== undefined && hasIndexProperty,
        });
        if (this.ans104Unbundler && hasIndexProperty) {
          this.ans104Unbundler.queueItem(item, prioritized, bypassFilter);
        }
        resolve();
      });

      data.stream.on('error', (error) => {
        const elapsedMs = Date.now() - startMs;
        metrics.bundleDownloadDurationSeconds.observe(
          { outcome: 'error' },
          elapsedMs / 1000,
        );
        metrics.bundleDownloadSizeBytes.observe({ outcome: 'error' }, size);
        log.error('Bundle download failed', {
          elapsedMs,
          size,
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

  // Ans104Parser requires items with indexes. A missing index doesn't always mean
  // that a tx/data-item is not unbundleable, but it does mean that it can't be unbundled
  // due to missing index, this (should) only happen when called directly during development.
  hasIndexPropery(item: ImportableItem): item is UnbundleableItem {
    return Object.keys(item).length > 1 && 'index' in item;
  }
}
