/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { ContiguousDataCacheIndex, ContiguousDataStore } from '../types.js';

// Bound work per sweep so a large backlog is reclaimed over several sweeps
// rather than one unbounded pass; the next sweep resumes.
const MAX_BATCHES_PER_SWEEP = 50;

// Concurrent blob unlinks per batch. The index row deletes are already batched
// into one transaction; the unlinks are the remaining (HDD-bound) cost, so run
// them in parallel to saturate the disk instead of one seek at a time.
const UNLINK_CONCURRENCY = 50;

/**
 * Disk-pressure evictor for the contiguous data cache, driven by the SQLite
 * cleanup index instead of a filesystem walk. When usage on the cache
 * filesystem crosses the high watermark (or free space drops below the min-free
 * floor), it queries the index for the oldest blobs (general tier first) and
 * reclaims them — deleting the index row, then unlinking the blob — until usage
 * recovers below the low watermark or the index is drained.
 *
 * `statfs` remains authoritative for "how full" (safety); the index only decides
 * "which blobs" (selection). Index drift is therefore harmless: a stale row just
 * unlinks a missing file (ENOENT-ignored), and the FS walk cleanup worker can
 * still run occasionally as a reconciler.
 */
export class ContiguousDataCacheEvictor {
  private log: Logger;
  private dataStore: ContiguousDataStore;
  private cacheIndex: ContiguousDataCacheIndex;
  private usagePath: string;
  private lowWatermarkPercent: number;
  private highWatermarkPercent: number;
  private minFreeBytes: number;
  private intervalMs: number;
  private batchSize: number;

  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor({
    log,
    dataStore,
    cacheIndex,
    usagePath,
    lowWatermarkPercent = config.CONTIGUOUS_DATA_CACHE_LOW_WATERMARK_PERCENT,
    highWatermarkPercent = config.CONTIGUOUS_DATA_CACHE_HIGH_WATERMARK_PERCENT,
    minFreeBytes = config.CONTIGUOUS_DATA_CACHE_MIN_FREE_BYTES,
    intervalMs = config.CONTIGUOUS_DATA_CACHE_INDEX_EVICTION_INTERVAL_MS,
    batchSize = config.CONTIGUOUS_DATA_CACHE_INDEX_EVICTION_BATCH_SIZE,
  }: {
    log: Logger;
    dataStore: ContiguousDataStore;
    cacheIndex: ContiguousDataCacheIndex;
    usagePath: string;
    lowWatermarkPercent?: number;
    highWatermarkPercent?: number;
    minFreeBytes?: number;
    intervalMs?: number;
    batchSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataStore = dataStore;
    this.cacheIndex = cacheIndex;
    this.usagePath = usagePath;
    this.lowWatermarkPercent = lowWatermarkPercent;
    this.highWatermarkPercent = highWatermarkPercent;
    this.minFreeBytes = minFreeBytes;
    this.intervalMs = intervalMs;
    this.batchSize = Math.max(1, batchSize);
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // { usedPercent, freeBytes } for the cache filesystem, or undefined on error.
  private async diskUsage(): Promise<
    { usedPercent: number; freeBytes: number } | undefined
  > {
    try {
      const stats = await fs.promises.statfs(this.usagePath);
      const total = stats.blocks;
      const usedPercent =
        total > 0 ? ((total - stats.bavail) / total) * 100 : 0;
      return { usedPercent, freeBytes: stats.bavail * stats.bsize };
    } catch (error: any) {
      this.log.warn('Failed to read filesystem usage', {
        usagePath: this.usagePath,
        error: error?.message,
      });
      return undefined;
    }
  }

  // Over the eviction trigger: at/above the high watermark, or below the
  // free-space floor.
  private overPressure(usedPercent: number, freeBytes: number): boolean {
    return (
      (this.highWatermarkPercent > 0 &&
        usedPercent >= this.highWatermarkPercent) ||
      (this.minFreeBytes > 0 && freeBytes < this.minFreeBytes)
    );
  }

  // Recovered below the trigger: under the low watermark and above the floor.
  private recovered(usedPercent: number, freeBytes: number): boolean {
    const underLow =
      this.lowWatermarkPercent <= 0 || usedPercent < this.lowWatermarkPercent;
    const aboveFloor = this.minFreeBytes <= 0 || freeBytes >= this.minFreeBytes;
    return underLow && aboveFloor;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) {
      return; // never overlap sweeps
    }
    this.sweeping = true;
    try {
      // Refresh observability gauges each sweep.
      try {
        metrics.cacheIndexEntriesGauge.set(
          await this.cacheIndex.countContiguousDataCacheEntries(),
        );
        metrics.cacheIndexBytesGauge.set(
          await this.cacheIndex.sumContiguousDataCacheBytes(),
        );
      } catch {
        // Gauges are best-effort; don't abort the sweep.
      }

      let usage = await this.diskUsage();
      if (usage === undefined) {
        return;
      }
      if (!this.overPressure(usage.usedPercent, usage.freeBytes)) {
        return;
      }

      this.log.info('Cache over pressure; evicting via index', {
        usedPercent: usage.usedPercent,
        freeBytes: usage.freeBytes,
        lowWatermarkPercent: this.lowWatermarkPercent,
        highWatermarkPercent: this.highWatermarkPercent,
      });

      let evicted = 0;
      let bytesFreed = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch++) {
        const candidates =
          await this.cacheIndex.selectContiguousDataCacheEvictionCandidates(
            this.batchSize,
          );
        if (candidates.length === 0) {
          this.log.warn(
            'Cache index drained but still over pressure; untracked files may need the FS reconciler',
            { usedPercent: usage.usedPercent },
          );
          break;
        }

        // Delete all the index rows in one transaction; it returns the hashes
        // actually removed (guards against a row deleted/re-cached between the
        // select and now), and only those get unlinked.
        const sizeByHash = new Map(candidates.map((c) => [c.hash, c.size]));
        const deletedHashes =
          await this.cacheIndex.deleteContiguousDataCacheEntries(
            candidates.map((c) => c.hash),
          );

        // Account metrics on the (authoritative) deleted rows, then unlink the
        // blobs in parallel — best-effort; a failed/ENOENT unlink still counts,
        // since the row is gone and the FS reconciler can heal any orphan.
        for (const hash of deletedHashes) {
          const size = sizeByHash.get(hash) ?? 0;
          evicted++;
          bytesFreed += size;
          metrics.cacheIndexEvictedTotal.inc({ reason: 'disk_pressure' });
          metrics.cacheIndexEvictedBytesTotal.inc(size);
        }
        const unlinkLimit = pLimit(UNLINK_CONCURRENCY);
        await Promise.all(
          deletedHashes.map((hash) =>
            unlinkLimit(() =>
              this.dataStore.delete(hash).catch((error: any) => {
                this.log.debug('Failed to unlink evicted blob', {
                  hash,
                  error: error?.message,
                });
              }),
            ),
          ),
        );

        usage = await this.diskUsage();
        if (usage === undefined) {
          break;
        }
        if (this.recovered(usage.usedPercent, usage.freeBytes)) {
          break;
        }
      }

      this.log.info('Index eviction sweep complete', {
        evicted,
        bytesFreed,
        usedPercent: usage?.usedPercent,
      });
    } catch (error: unknown) {
      this.log.warn('Index eviction sweep failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.sweeping = false;
    }
  }
}
