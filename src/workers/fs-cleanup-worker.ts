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

export class FsCleanupWorker {
  // Dependencies
  private log: winston.Logger;
  // Callback receives stats to avoid double-stat (worker stats once, passes to callback)
  private shouldDelete: (path: string, stats: fs.Stats) => Promise<boolean>;
  private deleteCallback: (path: string) => Promise<void>;

  private basePath: string;
  private dataType: string;
  private batchSize: number;
  private pauseDuration: number;
  private restartPauseDuration: number;
  private initialDelay: number;

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
  }: {
    log: winston.Logger;
    basePath: string;
    dataType: string;
    // Stats are passed to avoid redundant stat calls - use them instead of calling stat again
    shouldDelete?: (path: string, stats: fs.Stats) => Promise<boolean>;
    deleteCallback?: (path: string) => Promise<void>;
    batchSize?: number;
    pauseDuration?: number;
    restartPauseDuration?: number;
    initialDelay?: number;
  }) {
    this.log = log.child({ class: this.constructor.name, dataType });
    this.shouldDelete =
      shouldDelete ?? ((_path, _stats) => Promise.resolve(true));
    this.deleteCallback =
      deleteCallback ?? ((file: string) => fs.promises.unlink(file));

    this.basePath = basePath;
    this.dataType = dataType;
    this.lastPath = basePath;
    this.batchSize = batchSize;
    this.pauseDuration = pauseDuration;
    this.restartPauseDuration = restartPauseDuration;
    this.initialDelay = initialDelay;
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
        await this.processBatch();
        await new Promise((resolve) => setTimeout(resolve, this.pauseDuration));
      } catch (error: any) {
        this.log.error('Error processing batch', {
          error: error?.message,
          stack: error?.stack,
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.log.info('Stopping worker');
    this.shouldRun = false;
  }

  async processBatch(): Promise<void> {
    const { batch, keptFileCount, keptFileSize } = await this.getBatch(
      this.basePath,
      this.lastPath,
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

    this.log.info(`Deleting ${batch.length} files in ${this.basePath}}`);

    // Throttle concurrent deletes to avoid file descriptor exhaustion
    const limit = pLimit(DELETE_CONCURRENCY);
    await Promise.all(
      batch.map((file) =>
        limit(async () => {
          metrics.filesCleanedTotal.inc();
          if (this.deleteCallback !== undefined) {
            return this.deleteCallback(file);
          } else {
            return fs.promises.unlink(file);
          }
        }),
      ),
    );

    this.lastPath = batch[batch.length - 1];
  }

  async getBatch(
    basePath: string,
    lastPath: string | null,
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
        if (totalFilesProcessed >= this.batchSize) break;

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
                if (await this.shouldDelete(fullPath, stats)) {
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
