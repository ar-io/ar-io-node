/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import { Logger } from 'winston';

import * as config from '../config.js';
import * as metrics from '../metrics.js';
import { ContiguousDataCacheIndex } from '../types.js';

// FsDataStore blob filenames are the 43-char base64url sha256 content hash.
const HASH_NAME_RE = /^[A-Za-z0-9_-]{43}$/;
const PROGRESS_LOG_INTERVAL_MS = 30_000;

/**
 * One-time backfill / drift reconciler for the contiguous data cache index.
 *
 * Walks the existing on-disk blob tree once and seeds an index row for every
 * blob not already tracked (insert-if-absent, so live cache-write entries with
 * accurate cached_at/tier are never clobbered). Backfilled rows use tier 0
 * (general) and a cached_at derived from the filesystem timestamps — a blob's
 * true tier is restored the next time it is (re)cached through the write path.
 *
 * This is the mechanism for adopting a pre-existing cache that predates the
 * index. The walk is HDD-bound (this is the one slow pass we accept); it runs
 * in the background and does not block startup. Because inserts are
 * insert-if-absent, re-running is safe/idempotent, so it can also serve as a
 * periodic drift reconciler for files added outside the write path.
 */
export class ContiguousDataCacheReconciler {
  private log: Logger;
  private cacheIndex: ContiguousDataCacheIndex;
  private baseDir: string;
  private batchSize: number;
  private walkConcurrency: number;

  private running = false;
  private buffer: {
    hash: string;
    size: number;
    cachedAt: number;
    tier: number;
  }[] = [];
  private backfilled = 0;
  private visited = 0;
  private lastProgressLogMs = 0;

  constructor({
    log,
    cacheIndex,
    baseDir,
    batchSize = config.CONTIGUOUS_DATA_CACHE_INDEX_BACKFILL_BATCH_SIZE,
    walkConcurrency = config.FS_CLEANUP_WORKER_WALK_CONCURRENCY,
  }: {
    log: Logger;
    cacheIndex: ContiguousDataCacheIndex;
    baseDir: string;
    batchSize?: number;
    walkConcurrency?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cacheIndex = cacheIndex;
    this.baseDir = baseDir;
    this.batchSize = Math.max(1, batchSize);
    this.walkConcurrency = Math.max(1, walkConcurrency);
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    // Capture-and-swap synchronously so concurrent walkers can't lose rows or
    // double-insert (JS single-threaded: no other task runs before the swap).
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.cacheIndex.insertContiguousDataCacheEntriesIfAbsent(batch);
      this.backfilled += batch.length;
      metrics.cacheIndexBackfilledTotal.inc(batch.length);
    } catch (error: any) {
      this.log.warn('Backfill insert failed; dropping batch', {
        count: batch.length,
        error: error?.message,
      });
    }
  }

  private maybeLogProgress(): void {
    const now = Date.now();
    if (now - this.lastProgressLogMs >= PROGRESS_LOG_INTERVAL_MS) {
      this.lastProgressLogMs = now;
      this.log.info('Cache index backfill progress', {
        visited: this.visited,
        backfilled: this.backfilled,
        buffered: this.buffer.length,
      });
    }
  }

  // Run one full backfill pass. Fire-and-forget from startup; safe to re-run.
  async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastProgressLogMs = Date.now();
    this.log.info('Starting cache index backfill', { baseDir: this.baseDir });

    const limit = pLimit(this.walkConcurrency);

    const walk = async (dir: string): Promise<void> => {
      if (!this.running) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = await limit(() =>
          fs.promises.readdir(dir, { withFileTypes: true }),
        );
      } catch (error: any) {
        this.log.debug('Backfill: directory not accessible, skipping', {
          dir,
          code: error?.code,
        });
        return;
      }

      // Window the entries so recursion breadth (pending promises) stays bounded
      // even on a tree with millions of directories; the shared limiter bounds
      // actual syscall concurrency.
      for (
        let i = 0;
        i < entries.length && this.running;
        i += this.walkConcurrency
      ) {
        const window = entries.slice(i, i + this.walkConcurrency);
        await Promise.all(
          window.map(async (entry) => {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await walk(fullPath);
              return;
            }
            if (!entry.isFile() || !HASH_NAME_RE.test(entry.name)) {
              return;
            }
            try {
              const stats = await limit(() => fs.promises.stat(fullPath));
              const cachedAt = Math.floor(
                Math.max(stats.atimeMs, stats.mtimeMs) / 1000,
              );
              this.buffer.push({
                hash: entry.name,
                size: stats.size,
                cachedAt,
                tier: 0,
              });
              this.visited++;
              this.maybeLogProgress();
              if (this.buffer.length >= this.batchSize) {
                await this.flush();
              }
            } catch (error: any) {
              if (error?.code !== 'ENOENT') {
                this.log.debug('Backfill: error statting file', {
                  path: fullPath,
                  error: error?.message,
                });
              }
            }
          }),
        );
      }
    };

    try {
      await walk(this.baseDir);
      await this.flush();
      this.log.info('Cache index backfill complete', {
        visited: this.visited,
        backfilled: this.backfilled,
        aborted: !this.running,
      });
    } catch (error: any) {
      this.log.warn('Cache index backfill failed', { error: error?.message });
    } finally {
      this.running = false;
    }
  }
}
