/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import fs from 'node:fs';
import path from 'node:path';
import * as winston from 'winston';

import * as config from '../config.js';

const DEFAULT_INTERVAL_MS = config.CHUNK_SYMLINK_CLEANUP_INTERVAL * 1000;
const INITIAL_DELAY_MS = 60 * 1000; // 1 minute

/**
 * Worker that periodically scans directories for dead symlinks and removes them.
 * Recursively walks each configured directory to find and clean up symlinks
 * whose targets no longer exist.
 */
export class SymlinkCleanupWorker {
  private log: winston.Logger;
  private intervalMs: number;
  private intervalId?: NodeJS.Timeout;
  private initialTimeoutId?: NodeJS.Timeout;
  private directories: string[];

  constructor({
    log,
    directories,
    intervalMs = DEFAULT_INTERVAL_MS,
  }: {
    log: winston.Logger;
    directories: string[];
    intervalMs?: number;
  }) {
    this.log = log.child({ class: 'SymlinkCleanupWorker' });
    this.directories = directories;
    this.intervalMs = intervalMs;
  }

  start(): void {
    // Run initial cleanup after a short delay
    this.initialTimeoutId = setTimeout(() => {
      this.cleanup();
    }, INITIAL_DELAY_MS);

    // Schedule periodic cleanup
    this.intervalId = setInterval(this.cleanup.bind(this), this.intervalMs);

    this.log.info('Started symlink cleanup worker', {
      directories: this.directories,
      intervalMs: this.intervalMs,
      initialDelayMs: INITIAL_DELAY_MS,
    });
  }

  stop(): void {
    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    this.log.info('Stopped symlink cleanup worker');
  }

  private async cleanup(): Promise<void> {
    try {
      this.log.info('Starting symlink cleanup');
      const startTime = Date.now();

      const results = await Promise.all(
        this.directories.map((dir) => this.cleanupDirectory(dir)),
      );

      const totalCleaned = results.reduce((sum, count) => sum + count, 0);
      const duration = Date.now() - startTime;

      this.log.info('Symlink cleanup completed', {
        totalSymlinksRemoved: totalCleaned,
        durationMs: duration,
      });
    } catch (error: any) {
      this.log.error('Symlink cleanup failed', {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  private async cleanupDirectory(directory: string): Promise<number> {
    let cleanedCount = 0;

    try {
      // Check if directory exists
      try {
        await fs.promises.access(directory);
      } catch {
        return 0; // Directory doesn't exist yet
      }

      cleanedCount = await this.cleanupRecursive(directory);

      if (cleanedCount > 0) {
        this.log.info('Cleaned up dead symlinks', {
          directory,
          count: cleanedCount,
        });
      }
    } catch (error: any) {
      this.log.error('Error during symlink cleanup', {
        directory,
        message: error.message,
        stack: error.stack,
      });
    }

    return cleanedCount;
  }

  private async cleanupRecursive(directory: string): Promise<number> {
    let cleanedCount = 0;

    const entries = await fs.promises.readdir(directory, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);

      try {
        if (entry.isSymbolicLink()) {
          // Check if symlink target exists
          try {
            await fs.promises.stat(fullPath); // Follows symlink
          } catch {
            // Target doesn't exist - dead symlink
            await fs.promises.unlink(fullPath);
            cleanedCount++;
          }
        } else if (entry.isDirectory()) {
          // Recurse into subdirectories
          cleanedCount += await this.cleanupRecursive(fullPath);
        }
      } catch {
        // Error processing entry, skip
      }
    }

    return cleanedCount;
  }
}
