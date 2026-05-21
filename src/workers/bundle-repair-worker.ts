/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as winston from 'winston';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

import { BundleIndex, PartialJsonTransaction } from '../types.js';
import { Ans104Unbundler, UnbundleableItem } from './ans104-unbundler.js';

type CycleKind = 'retry' | 'timestamp_update' | 'backfill' | 'filter_reprocess';

/**
 * Builds a minimal PartialJsonTransaction-shaped item for re-queueing a
 * bundle to the unbundler. The unbundler's `unbundle()` only reads `id`,
 * the presence of `last_tx` (to discriminate L1 from BDI), and `index`
 * from the item; the rest is consumed only when filter matching runs.
 * With `bypassFilter=true` the filter doesn't read tags or other fields,
 * so a minimal item suffices.
 *
 * `selectFailedBundleIds` (the SQL behind `BundleIndex.getFailedBundleIds`)
 * already aliases `bundles.root_transaction_id AS id`, so the value we
 * pass here is the parent L1's id for BDIs and the L1's own id for L1s.
 * Both shapes route through the unbundler's L1 branch
 * (`rootTxId = item.id`), which is correct: parsing the L1 from offset 0
 * re-emits all children including any failed BDI nested under it, with
 * proper offsets discovered by the parser.
 */
function buildRootBundleItem(rootTxId: string): UnbundleableItem {
  const tx: PartialJsonTransaction = {
    id: rootTxId,
    signature: null,
    format: 2,
    last_tx: '',
    owner: '',
    target: '',
    quantity: '0',
    reward: '0',
    data_size: '0',
    data_root: '',
    tags: [],
  };
  return { ...tx, index: -1 };
}

export class BundleRepairWorker {
  // Dependencies
  private log: winston.Logger;
  private bundleIndex: BundleIndex;
  private ans104Unbundler: Ans104Unbundler;
  private unbundledFilter: string;
  private indexFilter: string;
  private shouldBackfillBundles: boolean;
  private filtersChanged: boolean;
  private intervalIds: NodeJS.Timeout[] = [];

  constructor({
    log,
    bundleIndex,
    ans104Unbundler,
    unbundleFilter,
    indexFilter,
    shouldBackfillBundles,
    filtersChanged,
  }: {
    log: winston.Logger;
    bundleIndex: BundleIndex;
    ans104Unbundler: Ans104Unbundler;
    unbundleFilter: string;
    indexFilter: string;
    shouldBackfillBundles: boolean;
    filtersChanged: boolean;
  }) {
    this.log = log.child({ class: 'BundleRepairWorker' });
    this.bundleIndex = bundleIndex;
    this.ans104Unbundler = ans104Unbundler;
    this.unbundledFilter = unbundleFilter;
    this.indexFilter = indexFilter;
    this.shouldBackfillBundles = shouldBackfillBundles;
    this.filtersChanged = filtersChanged;
  }

  async start(): Promise<void> {
    const defaultInterval = setInterval(
      this.retryBundles.bind(this),
      config.BUNDLE_REPAIR_RETRY_INTERVAL_SECONDS * 1000,
    );
    this.intervalIds.push(defaultInterval);

    const defaultUpdateInterval = setInterval(
      this.updateBundleTimestamps.bind(this),
      config.BUNDLE_REPAIR_UPDATE_TIMESTAMPS_INTERVAL_SECONDS * 1000,
    );
    this.intervalIds.push(defaultUpdateInterval);

    if (this.shouldBackfillBundles) {
      const backFillInterval = setInterval(
        this.backfillBundles.bind(this),
        config.BUNDLE_REPAIR_BACKFILL_INTERVAL_SECONDS * 1000,
      );
      this.intervalIds.push(backFillInterval);
    }

    if (this.filtersChanged) {
      const filterInterval = setInterval(
        this.updateForFilterChange.bind(this),
        config.BUNDLE_REPAIR_FILTER_REPROCESS_INTERVAL_SECONDS * 1000,
      );
      this.intervalIds.push(filterInterval);
    }
  }

  async stop(): Promise<void> {
    const log = this.log.child({ method: 'stop' });

    this.intervalIds.forEach((intervalId) => clearInterval(intervalId));
    this.intervalIds = [];

    log.debug('Stopped successfully.');
  }

  /**
   * Runs `fn` and observes the wall-clock duration into the
   * `bundle_repair_cycle_duration_seconds{kind}` histogram. On thrown
   * exceptions, increments `bundle_repair_errors_total{kind}` and rethrows.
   * Caller is responsible for surrounding try/catch — keeps the metric
   * side of the wrapper minimal.
   */
  private async measure<T>(kind: CycleKind, fn: () => Promise<T>): Promise<T> {
    const stop = metrics.bundleRepairCycleDurationHistogram
      .labels({ kind })
      .startTimer();
    try {
      return await fn();
    } catch (error) {
      metrics.bundleRepairErrorsCounter.inc({ kind });
      throw error;
    } finally {
      stop();
    }
  }

  async retryBundles() {
    try {
      await this.measure('retry', async () => {
        const bundleIds = await this.bundleIndex.getFailedBundleIds(
          config.BUNDLE_REPAIR_RETRY_BATCH_SIZE,
        );
        for (const bundleId of bundleIds) {
          this.log.info('Retrying failed bundle', { bundleId });
          await this.bundleIndex.saveBundleRetries(bundleId);

          // Queue directly to the unbundler rather than routing through
          // TransactionFetcher → TransactionImporter → TX_INDEXED event →
          // unbundler-subscription. The event-driven chain silently drops
          // retries when the unbundler queue is full at the moment the
          // event fires, and subsequent TxFetcher re-queues for the same
          // already-imported L1 are no-ops, leaving the bundle stuck. A
          // direct queueItem call ensures every retry cycle attempts an
          // unbundle. With bypassFilter=true the filter doesn't re-run;
          // we're explicitly retrying a bundle that was previously
          // accepted, so the filter has nothing new to say. Queue-full
          // backpressure still applies (see bundlesUnbundleSkippedCounter)
          // — the call returns without parsing if the unbundler is
          // saturated, letting the next cycle try again.
          //
          // Note: `bundleId` here is the bundle row's
          // `root_transaction_id` (per the alias in `selectFailedBundleIds`).
          // For BDIs that's the parent L1; the parser re-reads the
          // parent and re-emits all children with correct offsets,
          // which causes any nested BDI in the failed pool to re-enter
          // the unbundle pipeline naturally.
          await this.ans104Unbundler.queueItem(
            buildRootBundleItem(bundleId),
            false /* prioritized */,
            true /* bypassFilter */,
          );
          metrics.bundleRepairRetriesCounter.inc({ kind: 'retry' });
        }
      });
    } catch (error: any) {
      this.log.error('Error retrying failed bundles:', error);
    }
  }

  async updateBundleTimestamps() {
    try {
      await this.measure('timestamp_update', async () => {
        this.log.info('Updating bundle timestamps...');
        await this.bundleIndex.updateBundlesFullyIndexedAt();
        this.log.info('Bundle timestamps updated.');

        // Refresh the pending-backlog gauge on the same cadence as the
        // timestamp update so the dashboard reflects the post-update
        // state. Failure here is non-fatal — we'd rather miss one gauge
        // refresh than fail the cycle outright.
        try {
          const pending = await this.bundleIndex.getRepairBacklogCount();
          metrics.bundleRepairPendingBundlesGauge.set(pending);
          const backlog = await this.bundleIndex.getFullRepairBacklogCount();
          metrics.bundlesUnbundlingBacklogGauge.set(backlog);
        } catch (gaugeError: any) {
          this.log.warn('Failed to refresh bundle repair backlog gauges', {
            error: gaugeError?.message ?? String(gaugeError),
          });
        }
      });
    } catch (error: any) {
      this.log.error('Error updating bundle timestamps:', error);
    }
  }

  async backfillBundles() {
    try {
      await this.measure('backfill', async () => {
        this.log.info('Backfilling bundle records...');
        await this.bundleIndex.backfillBundles();
        this.log.info('Bundle records backfilled.');
      });
    } catch (error: any) {
      this.log.error('Error backfilling bundle records:', error);
    }
  }

  async updateForFilterChange() {
    try {
      await this.measure('filter_reprocess', async () => {
        this.log.info('Update bundles for filter change...');
        await this.bundleIndex.updateBundlesForFilterChange(
          this.unbundledFilter,
          this.indexFilter,
        );
        this.log.info('Bundles updated for filter change.');
      });
    } catch (error: any) {
      this.log.error('Error updating bundles for filter change:', error);
    }
  }
}
