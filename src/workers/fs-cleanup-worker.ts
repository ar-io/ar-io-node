/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import * as winston from 'winston';
import * as config from '../config.js';
import * as metrics from '../metrics.js';

// Limit concurrent delete operations to avoid file descriptor exhaustion
const DELETE_CONCURRENCY = 50;

// Under maximum disk pressure the sweep runs harder: up to this many times the
// configured batch size, with pauses shortened toward this floor.
const AGGRESSIVE_MAX_BATCH_MULTIPLIER = 4;
const AGGRESSIVE_MIN_PAUSE_DURATION_MS = 250;

/**
 * Per-batch cleanup context passed to a worker's `shouldDelete` policy so it can
 * scale its age thresholds with disk pressure. With watermarks disabled (the
 * default) every batch runs with {@link NORMAL_CONTEXT}, i.e. unchanged behavior.
 */
export interface CleanupContext {
  // Multiplier applied to age thresholds. 1 = normal retention; values < 1
  // tighten retention as disk pressure rises.
  thresholdScale: number;
  // Absolute floor (seconds): never delete data younger than this, even under
  // maximum pressure. `shouldDelete` should apply it as
  // `effective = max(baseThreshold * thresholdScale, minAgeSeconds)`.
  minAgeSeconds: number;
  regime: 'normal' | 'aggressive';
}

export const NORMAL_CONTEXT: CleanupContext = {
  thresholdScale: 1,
  minAgeSeconds: 0,
  regime: 'normal',
};

type CleanupDecision =
  | { action: 'skip'; usedPercent: number }
  | {
      action: 'clean';
      ctx: CleanupContext;
      batchSize: number;
      pauseMs: number;
    };

export class FsCleanupWorker {
  // Dependencies
  private log: winston.Logger;
  // Callback receives stats to avoid double-stat (worker stats once, passes to callback)
  private shouldDelete: (
    path: string,
    stats: fs.Stats,
    ctx: CleanupContext,
  ) => Promise<boolean>;
  private deleteCallback: (path: string) => Promise<void>;

  private basePath: string;
  private dataType: string;
  private batchSize: number;
  private pauseDuration: number;
  private restartPauseDuration: number;
  private initialDelay: number;

  // Disk-pressure watermarks (all opt-in; disabled => pure age-based cleanup)
  private usagePath: string;
  private lowWatermarkPercent: number;
  private highWatermarkPercent: number;
  private minFreeBytes: number;
  private aggressiveMinAgeSeconds: number;
  private watermarksEnabled: boolean;
  // Hysteresis latch: true once the high watermark (or free-space floor) has
  // triggered aggressive cleanup, cleared only after usage recovers below the
  // low watermark.
  private draining = false;

  private shouldRun = true;
  private lastPath: string | null = null;

  // Running totals for the current cycle
  private cycleKeptFileCount = 0;
  private cycleKeptFileSize = 0;

  constructor({
    log,
    basePath,
    dataType,
    shouldDelete,
    deleteCallback,
    batchSize = config.FS_CLEANUP_WORKER_BATCH_SIZE,
    pauseDuration = config.FS_CLEANUP_WORKER_BATCH_PAUSE_DURATION,
    restartPauseDuration = config.FS_CLEANUP_WORKER_RESTART_PAUSE_DURATION,
    initialDelay = 0,
    usagePath,
    lowWatermarkPercent = 0,
    highWatermarkPercent = 0,
    minFreeBytes = 0,
    aggressiveMinAgeSeconds = 0,
  }: {
    log: winston.Logger;
    basePath: string;
    dataType: string;
    // Stats are passed to avoid redundant stat calls - use them instead of calling stat again
    shouldDelete?: (
      path: string,
      stats: fs.Stats,
      ctx: CleanupContext,
    ) => Promise<boolean>;
    deleteCallback?: (path: string) => Promise<void>;
    batchSize?: number;
    pauseDuration?: number;
    restartPauseDuration?: number;
    initialDelay?: number;
    // Filesystem to measure for disk pressure (defaults to basePath)
    usagePath?: string;
    // Skip cleanup while filesystem usage is below this percent (0 disables)
    lowWatermarkPercent?: number;
    // Escalate to aggressive cleanup at/above this percent (0 disables)
    highWatermarkPercent?: number;
    // Force aggressive cleanup when free bytes drop below this (0 disables)
    minFreeBytes?: number;
    // Never evict data younger than this under aggressive cleanup
    aggressiveMinAgeSeconds?: number;
  }) {
    this.log = log.child({ class: this.constructor.name, dataType });
    this.shouldDelete =
      shouldDelete ?? ((_path, _stats, _ctx) => Promise.resolve(true));
    this.deleteCallback =
      deleteCallback ?? ((file: string) => fs.promises.unlink(file));

    this.basePath = basePath;
    this.dataType = dataType;
    this.lastPath = basePath;
    this.batchSize = batchSize;
    this.pauseDuration = pauseDuration;
    this.restartPauseDuration = restartPauseDuration;
    this.initialDelay = initialDelay;

    this.usagePath = usagePath ?? basePath;
    this.lowWatermarkPercent = lowWatermarkPercent;
    this.highWatermarkPercent = highWatermarkPercent;
    this.minFreeBytes = minFreeBytes;
    this.aggressiveMinAgeSeconds = aggressiveMinAgeSeconds;
    this.watermarksEnabled =
      lowWatermarkPercent > 0 || highWatermarkPercent > 0 || minFreeBytes > 0;
  }

  async start(): Promise<void> {
    // Check if base path exists and log warning if not
    try {
      await fs.promises.access(this.basePath, fs.constants.F_OK);
    } catch (error) {
      this.log.warn('Base path does not exist', {
        basePath: this.basePath,
      });
    }

    // Delay first cleanup if configured
    if (this.initialDelay > 0) {
      this.log.info(`Delaying initial cleanup by ${this.initialDelay}ms`);
      await new Promise((resolve) => setTimeout(resolve, this.initialDelay));
    }

    this.log.info('Starting worker');
    while (this.shouldRun) {
      try {
        const decision = await this.decideCleanup();
        if (decision.action === 'skip') {
          this.log.debug('Below low watermark; skipping cleanup cycle', {
            usedPercent: decision.usedPercent,
            lowWatermarkPercent: this.lowWatermarkPercent,
          });
          await new Promise((resolve) =>
            setTimeout(resolve, this.pauseDuration),
          );
          continue;
        }
        await this.processBatch(decision.ctx, decision.batchSize);
        await new Promise((resolve) => setTimeout(resolve, decision.pauseMs));
      } catch (error: any) {
        this.log.error('Error processing batch', {
          error: error?.message,
          stack: error?.stack,
        });
      }
    }
  }

  /**
   * Decide whether and how aggressively to clean this batch based on filesystem
   * usage. With watermarks disabled this always returns a normal-regime decision
   * (no statfs call), preserving pure age-based cleanup.
   */
  async decideCleanup(): Promise<CleanupDecision> {
    if (!this.watermarksEnabled) {
      return {
        action: 'clean',
        ctx: NORMAL_CONTEXT,
        batchSize: this.batchSize,
        pauseMs: this.pauseDuration,
      };
    }

    let usedPercent: number;
    let freeBytes: number;
    try {
      const stats = await fs.promises.statfs(this.usagePath);
      const total = stats.blocks;
      const avail = stats.bavail;
      usedPercent = total > 0 ? ((total - avail) / total) * 100 : 0;
      freeBytes = stats.bavail * stats.bsize;
    } catch (error: any) {
      // If usage can't be read, fall back to normal age-based cleanup rather
      // than skipping (which could let the disk fill unbounded).
      this.log.warn('Failed to read filesystem usage; using normal cleanup', {
        usagePath: this.usagePath,
        error: error?.message,
      });
      return {
        action: 'clean',
        ctx: NORMAL_CONTEXT,
        batchSize: this.batchSize,
        pauseMs: this.pauseDuration,
      };
    }

    metrics.cacheCleanupDiskUsedPercent.set(
      { data_type: this.dataType },
      usedPercent,
    );

    const belowMinFree = this.minFreeBytes > 0 && freeBytes < this.minFreeBytes;

    // Hysteresis: enter the draining (aggressive) state at the high watermark or
    // free-space floor, and stay there until usage recovers below the low
    // watermark. This produces a sawtooth between the watermarks instead of
    // flapping between normal and aggressive around the high watermark. Without
    // a low watermark configured there is no drain target, so it reverts as soon
    // as usage falls below the high watermark.
    if (
      this.draining &&
      !belowMinFree &&
      (this.lowWatermarkPercent <= 0 || usedPercent < this.lowWatermarkPercent)
    ) {
      this.draining = false;
    }
    if (
      belowMinFree ||
      (this.highWatermarkPercent > 0 &&
        usedPercent >= this.highWatermarkPercent)
    ) {
      this.draining = true;
    }

    // Skip regime: plenty of headroom and not draining.
    if (
      !belowMinFree &&
      !this.draining &&
      this.lowWatermarkPercent > 0 &&
      usedPercent < this.lowWatermarkPercent
    ) {
      metrics.cacheCleanupRegime.set({ data_type: this.dataType }, 0);
      return { action: 'skip', usedPercent };
    }

    // Aggressive regime: draining toward the low watermark. Pressure ramps from
    // 0 at the high watermark to 1 at a full disk (a breached free-space floor
    // forces maximum pressure); it is clamped to 0 while draining below the high
    // watermark, where cleanup runs at the normal threshold but does not skip.
    if (this.draining) {
      const span = Math.max(1, 100 - this.highWatermarkPercent);
      const pressure = belowMinFree
        ? 1
        : Math.max(
            0,
            Math.min(1, (usedPercent - this.highWatermarkPercent) / span),
          );
      metrics.cacheCleanupRegime.set({ data_type: this.dataType }, 2);
      return {
        action: 'clean',
        ctx: {
          // 1 -> 0 as the disk fills; minAgeSeconds is the hard floor.
          thresholdScale: 1 - pressure,
          minAgeSeconds: this.aggressiveMinAgeSeconds,
          regime: 'aggressive',
        },
        batchSize: Math.round(
          this.batchSize *
            (1 + pressure * (AGGRESSIVE_MAX_BATCH_MULTIPLIER - 1)),
        ),
        pauseMs: Math.max(
          AGGRESSIVE_MIN_PAUSE_DURATION_MS,
          Math.round(this.pauseDuration * (1 - pressure)),
        ),
      };
    }

    // Normal regime: between the watermarks and not draining.
    metrics.cacheCleanupRegime.set({ data_type: this.dataType }, 1);
    return {
      action: 'clean',
      ctx: NORMAL_CONTEXT,
      batchSize: this.batchSize,
      pauseMs: this.pauseDuration,
    };
  }

  async stop(): Promise<void> {
    this.log.info('Stopping worker');
    this.shouldRun = false;
  }

  async processBatch(
    ctx: CleanupContext = NORMAL_CONTEXT,
    batchSize: number = this.batchSize,
  ): Promise<void> {
    const { batch, keptFileCount, keptFileSize } = await this.getBatch(
      this.basePath,
      this.lastPath,
      ctx,
      batchSize,
    );

    // Add to running totals
    this.cycleKeptFileCount += keptFileCount;
    this.cycleKeptFileSize += keptFileSize;

    if (batch.length === 0) {
      this.log.info('No more files to delete, restarting from the base path');

      // Update metrics with final totals for this cycle
      const labels = { store_type: 'filesystem', data_type: this.dataType };
      metrics.cacheObjectsTotal.set(labels, this.cycleKeptFileCount);
      metrics.cacheSizeBytes.set(labels, this.cycleKeptFileSize);

      // Reset for next cycle
      this.cycleKeptFileCount = 0;
      this.cycleKeptFileSize = 0;
      this.lastPath = this.basePath;

      await new Promise((resolve) =>
        setTimeout(resolve, this.restartPauseDuration),
      );
      return;
    }

    this.log.info(`Deleting ${batch.length} files in ${this.basePath}`);

    // Throttle concurrent deletes to avoid file descriptor exhaustion
    const limit = pLimit(DELETE_CONCURRENCY);
    await Promise.all(
      batch.map((file) =>
        limit(async () => {
          metrics.filesCleanedTotal.inc({ data_type: this.dataType });
          return this.deleteCallback(file);
        }),
      ),
    );

    this.lastPath = batch[batch.length - 1];
  }

  async getBatch(
    basePath: string,
    lastPath: string | null,
    ctx: CleanupContext = NORMAL_CONTEXT,
    batchSize: number = this.batchSize,
  ): Promise<{
    batch: string[];
    keptFileCount: number;
    keptFileSize: number;
  }> {
    const batch: string[] = [];
    let totalFilesProcessed = 0;
    let keptFileCount = 0;
    let keptFileSize = 0;

    const walk = async (dir: string) => {
      let files;
      try {
        files = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (error: any) {
        // Directory doesn't exist or isn't accessible - skip silently
        if (error.code === 'ENOENT' || error.code === 'EACCES') {
          this.log.debug('Directory not accessible, skipping', {
            dir,
            code: error.code,
          });
          return;
        }
        throw error;
      }

      files.sort((a, b) => a.name.localeCompare(b.name));

      for (const file of files) {
        if (totalFilesProcessed >= batchSize) break;

        const fullPath = path.join(dir, file.name);

        // Skip .gitkeep files
        if (file.name === '.gitkeep') {
          continue;
        }

        if (
          lastPath !== null &&
          (lastPath.startsWith(fullPath) || fullPath >= lastPath) &&
          file.isDirectory()
        ) {
          await walk(fullPath);
        } else {
          if (lastPath === null || fullPath > lastPath) {
            if (file.isFile()) {
              // Stat once and reuse for both shouldDelete check and metrics
              try {
                const stats = await fs.promises.stat(fullPath);
                if (await this.shouldDelete(fullPath, stats, ctx)) {
                  batch.push(fullPath);
                  totalFilesProcessed++;
                } else {
                  // Track kept files using already-fetched stats
                  keptFileCount++;
                  keptFileSize += stats.size;
                }
              } catch (error: any) {
                // File may have been deleted between readdir and stat, skip
                if (error.code !== 'ENOENT') {
                  this.log.debug('Error checking file', {
                    path: fullPath,
                    error: error.message,
                  });
                }
              }
            }
          }
        }
      }
    };

    await walk(basePath);

    return { batch, keptFileCount, keptFileSize };
  }
}
