/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as winston from 'winston';

import { toB64Url } from '../lib/encoding.js';
import { currentUnixTimestamp } from '../lib/time.js';
import { ClickHouseIndexCleanup, IndexCleanupFilter } from '../types.js';

export interface IndexCleanupDb {
  getIndexCleanupCandidateIds(params: {
    filter: IndexCleanupFilter;
    limit: number;
    afterId?: Buffer;
  }): Promise<{ ids: Buffer[]; hasMore: boolean }>;
  countIndexCleanupCandidates(filter: IndexCleanupFilter): Promise<number>;
  deleteIndexCleanupBundlesBatch(ids: Buffer[]): Promise<{
    stableDataItemTagsDeleted: number;
    stableDataItemsDeleted: number;
    newDataItemTagsDeleted: number;
    newDataItemsDeleted: number;
  }>;
  deleteIndexCleanupDataBatch(ids: Buffer[]): Promise<{
    contiguousDataIdParentsDeleted: number;
    contiguousDataIdsDeleted: number;
  }>;
}

export class IndexCleanupWorker {
  private log: winston.Logger;
  private db: IndexCleanupDb;
  private clickHouseCleanup?: ClickHouseIndexCleanup;
  private filter: IndexCleanupFilter;
  private intervalMs: number;
  private batchSize: number;
  private dryRun: boolean;
  private minAgeSeconds: number;
  private intervalId?: ReturnType<typeof setInterval>;
  private isRunning = false;

  constructor({
    log,
    db,
    clickHouseCleanup,
    filter,
    intervalMs,
    batchSize,
    dryRun,
    minAgeSeconds,
  }: {
    log: winston.Logger;
    db: IndexCleanupDb;
    clickHouseCleanup?: ClickHouseIndexCleanup;
    filter: IndexCleanupFilter;
    intervalMs: number;
    batchSize: number;
    dryRun: boolean;
    minAgeSeconds: number;
  }) {
    this.log = log.child({ class: 'IndexCleanupWorker' });
    this.db = db;
    this.clickHouseCleanup = clickHouseCleanup;
    this.filter = filter;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.dryRun = dryRun;
    this.minAgeSeconds = minAgeSeconds;
  }

  start(): void {
    // Run initial cleanup immediately, then on interval
    this.cleanup();
    this.intervalId = setInterval(() => this.cleanup(), this.intervalMs);
    this.log.info('Started index cleanup worker', {
      intervalMs: this.intervalMs,
      dryRun: this.dryRun,
      minAgeSeconds: this.minAgeSeconds,
      filter: this.filter,
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.log.info('Stopped index cleanup worker');
  }

  async cleanup(): Promise<void> {
    if (this.isRunning) {
      this.log.debug('Cleanup already in progress, skipping');
      return;
    }
    this.isRunning = true;

    try {
      const ageBasedThreshold = currentUnixTimestamp() - this.minAgeSeconds;
      const effectiveFilter: IndexCleanupFilter = {
        ...this.filter,
        maxIndexedAt:
          this.filter.maxIndexedAt !== undefined
            ? Math.min(this.filter.maxIndexedAt, ageBasedThreshold)
            : ageBasedThreshold,
      };

      this.log.info('Index cleanup cycle starting', {
        dryRun: this.dryRun,
        filter: effectiveFilter,
      });

      if (this.dryRun) {
        const count =
          await this.db.countIndexCleanupCandidates(effectiveFilter);
        this.log.info('Index cleanup dry run complete', {
          candidateCount: count,
          filter: effectiveFilter,
        });
        return;
      }

      let totalDeleted = 0;
      let afterId: Buffer | undefined;
      let hasMore = true;

      while (hasMore) {
        const { ids, hasMore: more } =
          await this.db.getIndexCleanupCandidateIds({
            filter: effectiveFilter,
            limit: this.batchSize,
            afterId,
          });

        if (ids.length === 0) break;

        const bundlesResult = await this.db.deleteIndexCleanupBundlesBatch(ids);
        await this.db.deleteIndexCleanupDataBatch(ids);

        const batchDeleted =
          bundlesResult.stableDataItemsDeleted +
          bundlesResult.newDataItemsDeleted;
        totalDeleted += batchDeleted;

        if (this.clickHouseCleanup) {
          const b64Ids = ids.map((id) => toB64Url(id));
          await this.clickHouseCleanup.deleteDataItemsByIds(b64Ids);
        }

        this.log.info('Index cleanup batch completed', {
          batchSize: ids.length,
          batchDeleted,
          totalDeleted,
        });

        afterId = ids[ids.length - 1];
        hasMore = more;
      }

      this.log.info('Index cleanup cycle completed', { totalDeleted });
    } catch (error: any) {
      this.log.error('Error during index cleanup', {
        error: error?.message,
        stack: error?.stack,
      });
    } finally {
      this.isRunning = false;
    }
  }
}
