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

import { Ans104Parser } from '../lib/ans-104.js';
import * as metrics from '../metrics.js';
import {
  BundleIndex,
  ContiguousDataSource,
  ItemFilter,
  NormalizedBundleDataItem,
  NormalizedDataItem,
  PartialJsonTransaction,
} from '../types.js';

const DEFAULT_MAX_QUEUE_SIZE = 1000;

interface IndexProperty {
  index: number;
}

export type UnbundleableItem = (NormalizedDataItem | PartialJsonTransaction) &
  IndexProperty;

const isNormalizedBundleDataItem = (
  item: UnbundleableItem,
): item is NormalizedBundleDataItem =>
  (item as NormalizedBundleDataItem).root_parent_offset !== undefined &&
  (item as NormalizedBundleDataItem).data_offset !== undefined;

export class Ans104Unbundler {
  // Dependencies
  private log: winston.Logger;
  private filter: ItemFilter;
  private bundleIndex: BundleIndex | undefined;

  // Unbundling queue
  private workerCount: number;
  private maxQueueSize: number;
  private queue: queueAsPromised<
    { item: UnbundleableItem; bypassFilter: boolean },
    void
  >;
  private shouldUnbundle: () => boolean;

  // Parser
  private ans104Parser: Ans104Parser;

  constructor({
    log,
    eventEmitter,
    filter,
    contiguousDataSource,
    dataItemIndexFilterString,
    workerCount,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
    shouldUnbundle = () => true,
    ans104Parser,
    bundleIndex,
  }: {
    log: winston.Logger;
    eventEmitter: EventEmitter;
    filter: ItemFilter;
    contiguousDataSource: ContiguousDataSource;
    dataItemIndexFilterString: string;
    workerCount: number;
    maxQueueSize?: number;
    shouldUnbundle?: () => boolean;
    ans104Parser?: Ans104Parser;
    /**
     * Optional index used to look up already-indexed children of a
     * bundle being parsed. When supplied, the parser receives the
     * id-set and skips re-emit for those children. Reduces redundant
     * pressure on the data-item indexer queues when a bundle is
     * re-parsed by the repair worker after some children were dropped
     * at the indexer's queue cap on a previous attempt. Tests can omit
     * this; production wires it from system.ts.
     */
    bundleIndex?: BundleIndex;
  }) {
    this.log = log.child({ class: 'Ans104Unbundler' });
    this.filter = filter;
    this.bundleIndex = bundleIndex;
    this.ans104Parser =
      ans104Parser ||
      new Ans104Parser({
        log,
        eventEmitter,
        contiguousDataSource,
        workerCount,
        dataItemIndexFilterString,
      });

    this.workerCount = workerCount;
    this.maxQueueSize = maxQueueSize;
    this.queue = fastq.promise(
      this.unbundle.bind(this),
      Math.max(workerCount, 1),
    );
    this.shouldUnbundle = shouldUnbundle;
  }

  async queueItem(
    item: UnbundleableItem,
    prioritized: boolean | undefined,
    bypassFilter = false,
  ): Promise<void> {
    const log = this.log.child({ method: 'queueItem', id: item.id });

    if (this.workerCount === 0) {
      metrics.bundlesUnbundleSkippedCounter.inc({ reason: 'no_workers' });
      log.warn('Skipping data item queuing due to no workers.');
      return;
    }

    if (!this.shouldUnbundle() && prioritized !== true) {
      metrics.bundlesUnbundleSkippedCounter.inc({
        reason: 'high_queue_depth',
      });
      log.warn('Skipping data item queuing due to high queue depth.');
      return;
    }

    if (prioritized === true) {
      log.debug('Queueing prioritized bundle...');
      this.queue.unshift({ item, bypassFilter });
      log.debug('Prioritized bundle queued.');
    } else if (this.queue.length() < this.maxQueueSize) {
      log.debug('Queueing bundle...');
      this.queue.push({ item, bypassFilter });
      log.debug('Bundle queued.');
    } else {
      metrics.bundlesUnbundleSkippedCounter.inc({ reason: 'queue_full' });
      log.debug('Skipping unbundle, queue is full.');
    }
  }

  async unbundle({
    item,
    bypassFilter,
  }: {
    item: UnbundleableItem;
    bypassFilter: boolean;
  }): Promise<void> {
    const log = this.log.child({ method: 'unbundle', id: item.id });
    try {
      let rootTxId: string | undefined;
      if ('root_tx_id' in item && item.root_tx_id !== null) {
        // Data item with root_tx_id
        rootTxId = item.root_tx_id;
      } else if ('last_tx' in item) {
        // Layer 1 transaction
        rootTxId = item.id;
      } else {
        // Data item without root_tx_id (should be impossible)
        throw new Error('Missing root_tx_id on data item.');
      }
      if (bypassFilter || (await this.filter.match(item))) {
        log.info('Unbundling bundle...');
        let rootParentOffset = 0;

        if (
          isNormalizedBundleDataItem(item) &&
          rootTxId !== item.id &&
          item.root_parent_offset !== null &&
          item.data_offset !== null
        ) {
          rootParentOffset = item.root_parent_offset + item.data_offset;
        }

        // Pre-fetch the set of children already indexed under this
        // parent so the parser can skip re-emit for them. This is the
        // primary efficiency lever when the repair worker re-queues a
        // bundle whose previous parse had some children dropped at the
        // data-item indexer's queue cap: without this set, the re-parse
        // re-queues every child (90%+ of which are idempotent no-ops at
        // the DB layer but still consume queue slots and contend with
        // the genuinely-new children for the cap). Lookup is a single
        // indexed SQLite read; if it fails for any reason we fall back
        // to the un-skipped behavior rather than failing the unbundle.
        let skipChildIds: string[] | undefined;
        if (this.bundleIndex !== undefined) {
          try {
            skipChildIds = await this.bundleIndex.getIndexedChildIds(item.id);
            if (skipChildIds.length > 0) {
              log.debug('Pre-loaded already-indexed children to skip', {
                count: skipChildIds.length,
              });
            }
          } catch (err: any) {
            log.warn(
              'Failed to pre-load already-indexed children; proceeding without skip-set',
              { error: err?.message ?? String(err) },
            );
            skipChildIds = undefined;
          }
        }

        await this.ans104Parser.parseBundle({
          rootTxId,
          parentId: item.id,
          parentIndex: item.index,
          rootParentOffset,
          skipChildIds,
        });
        log.info('Bundle unbundled.');
      }
    } catch (error: any) {
      log.error('Unbundling failed:', {
        message: error?.message,
        stack: error?.stack,
      });
    }
  }

  queueDepth(): number {
    return this.queue.length();
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });
    this.queue.kill();
    await this.ans104Parser.stop();
    log.debug('Stopped successfully.');
  }
}
