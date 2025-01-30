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
import * as winston from 'winston';
import * as config from '../config.js';

import { BundleIndex } from '../types.js';
import { TransactionFetcher } from './transaction-fetcher.js';

const DEFAULT_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BUNDLE_BACKFILL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_FILTER_REPOCESS_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

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
      DEFAULT_UPDATE_INTERVAL_MS,
    );
    this.intervalIds.push(defaultUpdateInterval);

    if (this.shouldBackfillBundles) {
      const backFillInterval = setInterval(
        this.backfillBundles.bind(this),
        DEFAULT_BUNDLE_BACKFILL_INTERVAL_MS,
      );
      this.intervalIds.push(backFillInterval);
    }

    if (this.filtersChanged) {
      const filterInterval = setInterval(
        this.updateForFilterChange.bind(this),
        DEFAULT_FILTER_REPOCESS_INTERVAL_MS,
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

  async retryBundles() {
    try {
      const bundleIds = await this.bundleIndex.getFailedBundleIds(
        config.BUNDLE_REPAIR_RETRY_BATCH_SIZE,
      );
      for (const bundleId of bundleIds) {
        this.log.info('Retrying failed bundle', { bundleId });
        await this.bundleIndex.saveBundleRetries(bundleId);
        await this.txFetcher.queueTxId({ txId: bundleId });
      }
    } catch (error: any) {
      this.log.error('Error retrying failed bundles:', error);
    }
  }

  async updateBundleTimestamps() {
    try {
      this.log.info('Updating bundle timestamps...');
      await this.bundleIndex.updateBundlesFullyIndexedAt();
      this.log.info('Bundle timestamps updated.');
    } catch (error: any) {
      this.log.error('Error updating bundle timestamps:', error);
    }
  }

  async backfillBundles() {
    try {
      this.log.info('Backfilling bundle records...');
      await this.bundleIndex.backfillBundles();
      this.log.info('Bundle records backfilled.');
    } catch (error: any) {
      this.log.error('Error backfilling bundle records:', error);
    }
  }

  async updateForFilterChange() {
    try {
      this.log.info('Update bundles for filter change...');
      await this.bundleIndex.updateBundlesForFilterChange(
        this.unbundledFilter,
        this.indexFilter,
      );
      this.log.info('Bundles updated for filter change.');
    } catch (error: any) {
      this.log.error('Error updating bundles for filter change:', error);
    }
  }
}
