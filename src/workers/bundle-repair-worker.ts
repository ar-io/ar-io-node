/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as winston from 'winston';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

import { BundleIndex } from '../types.js';
import { TransactionFetcher } from './transaction-fetcher.js';

type CycleKind = 'retry' | 'timestamp_update' | 'backfill' | 'filter_reprocess';

export class BundleRepairWorker {
  // Dependencies
  private log: winston.Logger;
  private bundleIndex: BundleIndex;
  private txFetcher: TransactionFetcher;
  private unbundledFilter: string;
  private indexFilter: string;
  private shouldBackfillBundles: boolean;
  private filtersChanged: boolean;
  private intervalIds: NodeJS.Timeout[] = [];

  constructor({
    log,
    bundleIndex,
    txFetcher,
    unbundleFilter,
    indexFilter,
    shouldBackfillBundles,
    filtersChanged,
  }: {
    log: winston.Logger;
    bundleIndex: BundleIndex;
    txFetcher: TransactionFetcher;
    unbundleFilter: string;
    indexFilter: string;
    shouldBackfillBundles: boolean;
    filtersChanged: boolean;
  }) {
    this.log = log.child({ class: 'BundleRepairWorker' });
    this.bundleIndex = bundleIndex;
    this.txFetcher = txFetcher;
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
          await this.txFetcher.queueTxId({ txId: bundleId });
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
        } catch (gaugeError: any) {
          this.log.warn(
            'Failed to refresh bundle_repair_pending_bundles gauge',
            { error: gaugeError?.message ?? String(gaugeError) },
          );
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
