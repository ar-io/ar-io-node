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
  ContiguousData,
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
  private downloadTimeoutMs: number;
  private queue: queueAsPromised<DataImporterQueueItem, void>;

  constructor({
    log,
    name = 'default',
    contiguousDataSource,
    ans104Unbundler,
    workerCount,
    maxQueueSize = config.BUNDLE_DATA_IMPORTER_QUEUE_SIZE,
    downloadTimeoutMs = config.DATA_IMPORTER_DOWNLOAD_TIMEOUT_MS,
  }: {
    log: winston.Logger;
    name?: string;
    contiguousDataSource: ContiguousDataSource;
    ans104Unbundler?: Ans104Unbundler;
    workerCount: number;
    maxQueueSize?: number;
    downloadTimeoutMs?: number;
  }) {
    this.name = name;
    this.log = log.child({ class: this.constructor.name, importer: name });
    this.contiguousDataSource = contiguousDataSource;
    if (ans104Unbundler) {
      this.ans104Unbundler = ans104Unbundler;
    }
    this.workerCount = workerCount;
    this.maxQueueSize = maxQueueSize;
    this.downloadTimeoutMs = downloadTimeoutMs;
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

    // Wall-clock cap on the WHOLE download using Promise.race against a
    // setTimeout-rejected promise. This is the AbortSignal-independent
    // version: regardless of whether abort propagates through the cascade,
    // download() is GUARANTEED to return when the timeout fires.
    //
    // Why Promise.race + setTimeout instead of just AbortController:
    // Investigation 2026-05-17/18 proved abort propagation through the
    // cascade is unreliable. Timer counter math showed `timer_fired`
    // increments without `download()` returning — 32 workers stuck pre-data
    // forever because `await contiguousDataSource.getData(...)` never threw
    // even after `abortController.abort()` was called. The downside of
    // Promise.race: the underlying cascade may continue running in the
    // background after the race is decided (resource leak we accept), but
    // the fastq worker is freed to pick up the next bundle.
    //
    // We still arm `abortController` and call `.abort()` from the timeout
    // callback — when abort DOES propagate (most cases), it cleans up the
    // background cascade properly. When it doesn't, Promise.race fires
    // anyway. Belt and suspenders.
    const abortController = new AbortController();
    let data: ContiguousData | undefined;
    let timedOut = false;
    // INSTRUMENTATION: counter-based timer lifecycle. Compare:
    //   timer_created   = downloads that armed a setTimeout
    //   timer_fired     = timeouts that won the race
    //   timer_cleared   = timeouts cleared by finally{} (normal completion)
    metrics.dataImporterPhaseCounter.inc({ phase: 'timer_created' });

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        const err = new Error(
          `DataImporter download exceeded ${this.downloadTimeoutMs}ms wall-clock cap`,
        );
        metrics.dataImporterPhaseCounter.inc({ phase: 'timer_fired' });
        log.info('optB.timer_fired', {
          id: item.id,
          timeoutMs: this.downloadTimeoutMs,
          hadStream: data !== undefined,
        });
        // Still attempt clean cancellation — when abort DOES propagate it
        // tears down the background work. When it doesn't, Promise.race
        // below frees the worker anyway via the reject().
        abortController.abort(err);
        if (data?.stream && !data.stream.destroyed) {
          try {
            data.stream.destroy(err);
          } catch {
            /* destroy on already-destroyed stream is a no-op */
          }
        }
        reject(err);
      }, this.downloadTimeoutMs);
    });

    // The actual download flow as an IIFE so Promise.race can pit it
    // against the timeout. The IIFE keeps running in the background if
    // timeoutPromise wins the race — that's the acceptable leak.
    const downloadPromise = (async () => {
      // Phase counters from #736: locate stuck workers when pipeline wedges.
      metrics.dataImporterPhaseCounter.inc({ phase: 'started' });
      try {
        data = await this.contiguousDataSource.getData({
          id: item.id,
          signal: abortController.signal,
        });
      } catch (error) {
        metrics.dataImporterPhaseCounter.inc({ phase: 'getData_errored' });
        throw error;
      }
      metrics.dataImporterPhaseCounter.inc({ phase: 'got_data' });
      const size = data.size;

      await new Promise<void>((resolve, reject) => {
        data!.stream.on('end', () => {
          metrics.dataImporterPhaseCounter.inc({ phase: 'stream_ended' });
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
            cached: data!.cached,
            willUnbundle:
              this.ans104Unbundler !== undefined && hasIndexProperty,
          });
          if (this.ans104Unbundler && hasIndexProperty) {
            this.ans104Unbundler.queueItem(item, prioritized, bypassFilter);
          }
          resolve();
        });

        data!.stream.on('error', (error) => {
          metrics.dataImporterPhaseCounter.inc({ phase: 'stream_errored' });
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

        data!.stream.resume();
      });
    })();

    // Suppress unhandled-rejection if downloadPromise loses the race and
    // eventually rejects (it can keep running in the background). Attaching
    // a .catch on the original promise marks any future rejection as handled
    // without affecting what Promise.race observes from `downloadPromise`.
    downloadPromise.catch(() => {
      /* loser of race — already handled via timeoutPromise reject */
    });

    try {
      await Promise.race([downloadPromise, timeoutPromise]);
    } catch (error: any) {
      if (timedOut) {
        log.warn('Download aborted by wall-clock cap', {
          timeoutMs: this.downloadTimeoutMs,
          message: error.message,
        });
      }
      throw error;
    } finally {
      // INSTRUMENTATION: timer_cleared only on normal completion path.
      if (!timedOut) {
        metrics.dataImporterPhaseCounter.inc({ phase: 'timer_cleared' });
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
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
