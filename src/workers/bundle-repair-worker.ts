/**
 * AR.IO Gateway
 * Copyright (C) 2023 Permanent Data Solutions, Inc
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

import { BundleIndex } from '../types.js';
import { TransactionFetcher } from './transaction-fetcher.js';

const DEFAULT_RETRY_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BUNDLE_BACKFILL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_BUNDLES_TO_RETRY = 20;

export class BundleRepairWorker {
  // Dependencies
  private log: winston.Logger;
  private bundleIndex: BundleIndex;
  private txFetcher: TransactionFetcher;
  private shouldBackfillBundles: boolean;

  constructor({
    log,
    bundleIndex,
    txFetcher,
    shouldBackfillBundles,
  }: {
    log: winston.Logger;
    bundleIndex: BundleIndex;
    txFetcher: TransactionFetcher;
    shouldBackfillBundles: boolean;
  }) {
    this.log = log.child({ class: 'BundleRepairWorker' });
    this.bundleIndex = bundleIndex;
    this.txFetcher = txFetcher;
    this.shouldBackfillBundles = shouldBackfillBundles;
  }

  async start(): Promise<void> {
    setInterval(this.retryBundles.bind(this), DEFAULT_RETRY_INTERVAL_MS);
    setInterval(
      this.updateBundleTimestamps.bind(this),
      DEFAULT_UPDATE_INTERVAL_MS,
    );
    if (this.shouldBackfillBundles) {
      setInterval(
        this.backfillBundles.bind(this),
        DEFAULT_BUNDLE_BACKFILL_INTERVAL_MS,
      );
    }
  }

  async retryBundles() {
    try {
      const bundleIds = await this.bundleIndex.getFailedBundleIds(
        DEFAULT_BUNDLES_TO_RETRY,
      );
      for (const bundleId of bundleIds) {
        this.log.info('Retrying failed bundle', { bundleId });
        await this.txFetcher.queueTxId(bundleId);
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
}
