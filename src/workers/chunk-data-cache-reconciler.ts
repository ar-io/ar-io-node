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
import { ChunkDataCacheIndex } from '../types.js';

const PROGRESS_LOG_INTERVAL_MS = 30_000;

// Depth of the data-root directory below baseDir in the FsChunkDataStore
// layout: <baseDir>/<hh>/<hh>/<dataRoot>/<relativeOffset>. The data root is the
// indexed unit, so the walk stops descending there and stats its files.
const DATA_ROOT_DEPTH = 3;

/**
 * One-time backfill / drift reconciler for the chunk data cache index.
 *
 * Walks the existing on-disk chunk tree once and seeds an index row for every
 * data root not already tracked (insert-if-absent, so live chunk-write entries
 * with accurate last_write/tier are never clobbered). Backfilled rows use tier
 * 0 (general); a data root's true tier is restored the next time one of its
 * chunks is (re)cached or read through the live path.
 *
 * Unlike the contiguous reconciler, which indexes one row per file, the chunk
 * cache's indexed unit is the data-root DIRECTORY at
 * `<baseDir>/<hh>/<hh>/<dataRoot>/`: eviction is all-or-nothing per data root,
 * so each row aggregates every chunk file in that directory (summed size,
 * chunk count, max write time, max access time).
 *
 * The walk is HDD-bound (this is the one slow pass we accept, and explicitly
 * the last full walk the cache should ever need); it runs in the background,
 * does not block startup, is bounded by `walkConcurrency`, and is abortable via
 * stop(). Because inserts are insert-if-absent, re-running is safe/idempotent,
 * so it can also serve as a periodic drift reconciler.
 */
export class ChunkDataCacheReconciler {
  private log: Logger;
  private cacheIndex: ChunkDataCacheIndex;
  private baseDir: string;
  private batchSize: number;
  private walkConcurrency: number;
  // Durable resume checkpoint: the name of the last fully-completed top-level
  // shard directory. Survives restarts so a bounce re-does at most one shard.
  private checkpointPath: string;

  private running = false;
  private buffer: {
    dataRoot: string;
    size: number;
    chunkCount: number;
    lastWrite: number;
    lastAccess: number;
    tier: number;
  }[] = [];
  private backfilled = 0;
  private visited = 0;
  private chunkFilesVisited = 0;
  private lastProgressLogMs = 0;

  constructor({
    log,
    cacheIndex,
    baseDir,
    batchSize = config.CHUNK_DATA_CACHE_INDEX_BACKFILL_BATCH_SIZE,
    walkConcurrency = config.FS_CLEANUP_WORKER_WALK_CONCURRENCY,
    checkpointPath,
  }: {
    log: Logger;
    cacheIndex: ChunkDataCacheIndex;
    baseDir: string;
    batchSize?: number;
    walkConcurrency?: number;
    checkpointPath?: string;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.cacheIndex = cacheIndex;
    // baseDir must point at the by-dataroot subtree. Its siblings
    // (by-absolute-offset, which is nothing but symlinks back into this tree,
    // and metadata) must never be walked: indexing the symlinks would
    // double-count every chunk they point at.
    this.baseDir = baseDir;
    this.batchSize = Math.max(1, batchSize);
    this.walkConcurrency = Math.max(1, walkConcurrency);
    // Default beside (not under) baseDir so the checkpoint file is never itself
    // walked/indexed.
    this.checkpointPath =
      checkpointPath ??
      path.join(baseDir, '..', '.chunk-cache-index-backfill-checkpoint');
  }

  private async loadCheckpoint(): Promise<string | null> {
    try {
      const value = (
        await fs.promises.readFile(this.checkpointPath, 'utf8')
      ).trim();
      return value.length > 0 ? value : null;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.log.debug('Backfill: could not read checkpoint', {
          path: this.checkpointPath,
          error: error?.message,
        });
      }
      return null;
    }
  }

  private async saveCheckpoint(name: string): Promise<void> {
    // Atomic write (temp + rename) so a crash can't leave a torn checkpoint.
    const tmp = `${this.checkpointPath}.tmp`;
    try {
      await fs.promises.writeFile(tmp, name);
      await fs.promises.rename(tmp, this.checkpointPath);
    } catch (error: any) {
      this.log.debug('Backfill: could not persist checkpoint', {
        name,
        error: error?.message,
      });
    }
  }

  private async clearCheckpoint(): Promise<void> {
    try {
      await fs.promises.unlink(this.checkpointPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        this.log.debug('Backfill: could not clear checkpoint', {
          error: error?.message,
        });
      }
    }
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
      await this.cacheIndex.insertChunkDataCacheEntriesIfAbsent(batch);
      this.backfilled += batch.length;
      metrics.chunkCacheIndexBackfilledTotal.inc(batch.length);
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
      this.log.info('Chunk cache index backfill progress', {
        dataRootsVisited: this.visited,
        chunkFilesVisited: this.chunkFilesVisited,
        backfilled: this.backfilled,
        buffered: this.buffer.length,
      });
    }
  }

  /**
   * Aggregate one data-root directory into a single index row.
   *
   * The timestamps are read from the chunk files themselves and NEVER from the
   * walk clock:
   *
   * - `lastWrite` is MAX(mtime). It is the age floor the evictor filters on
   *   (`WHERE last_write <= now - minAgeSeconds`), so seeding it with `now`
   *   would make the whole cache look uniformly freshly-written, put every row
   *   inside the floor, and stall eviction entirely until the floor elapsed.
   * - `lastAccess` is MAX(max(atime, mtime)) and drives LRU ordering. The
   *   volume is XFS mounted relatime, so a freshly written file has
   *   atime == mtime and the first read moves atime; max(atime, mtime) is
   *   therefore the best recency signal available. It genuinely discriminates
   *   (measured in production: 41.5% of cached bytes have a max(atime, mtime)
   *   older than 4h), whereas seeding it from the walk clock would make the
   *   entire cache look uniformly hot and destroy LRU ordering.
   *
   * Returns null for a data-root directory with no chunk files. Roughly two
   * thirds of on-disk data-root directories are empty (nothing rmdirs them
   * today), and an empty directory holds no bytes, so it must produce no row.
   */
  private async aggregateDataRoot(
    dir: string,
    dataRoot: string,
    limit: <T>(fn: () => Promise<T>) => Promise<T>,
  ): Promise<{
    dataRoot: string;
    size: number;
    chunkCount: number;
    lastWrite: number;
    lastAccess: number;
    tier: number;
  } | null> {
    let entries: fs.Dirent[];
    try {
      entries = await limit(() =>
        fs.promises.readdir(dir, { withFileTypes: true }),
      );
    } catch (error: any) {
      this.log.debug('Backfill: data root not accessible, skipping', {
        dir,
        code: error?.code,
      });
      return null;
    }

    let size = 0;
    let chunkCount = 0;
    let maxMtimeMs = 0;
    let maxAccessMs = 0;

    for (
      let i = 0;
      i < entries.length && this.running;
      i += this.walkConcurrency
    ) {
      const window = entries.slice(i, i + this.walkConcurrency);
      await Promise.all(
        window.map(async (entry) => {
          // Only plain files are chunks. Symlinks (the absolute-offset index)
          // and stray directories are not chunk data and must not be counted.
          if (!entry.isFile()) {
            return;
          }
          const fullPath = path.join(dir, entry.name);
          try {
            const stats = await limit(() => fs.promises.stat(fullPath));
            size += stats.size;
            chunkCount++;
            this.chunkFilesVisited++;
            if (stats.mtimeMs > maxMtimeMs) {
              maxMtimeMs = stats.mtimeMs;
            }
            const accessMs = Math.max(stats.atimeMs, stats.mtimeMs);
            if (accessMs > maxAccessMs) {
              maxAccessMs = accessMs;
            }
          } catch (error: any) {
            if (error?.code !== 'ENOENT') {
              this.log.debug('Backfill: error statting chunk file', {
                path: fullPath,
                error: error?.message,
              });
            }
          }
        }),
      );
    }

    // Aborted part-way through this directory: DISCARD the partial aggregate.
    // The file loop exits early on stop(), so `size`, `chunkCount` and -- the
    // dangerous one -- `lastWrite` describe only the files seen so far. A
    // lastWrite that is too OLD makes the row pass the evictor's age floor
    // sooner than it should, and eviction removes the whole data-root
    // directory, so a fresh (possibly still-unconfirmed) chunk that the walk
    // never reached would be destroyed. Backfill inserts with
    // ON CONFLICT DO NOTHING, so a poisoned row is never corrected by a later
    // re-run; only a subsequent write to that data root would repair it, and a
    // cold data root never gets one. Emitting nothing is always safe: an
    // unindexed data root simply is not an eviction candidate.
    if (!this.running) {
      return null;
    }

    if (chunkCount === 0) {
      return null;
    }

    return {
      dataRoot,
      size,
      chunkCount,
      lastWrite: Math.floor(maxMtimeMs / 1000),
      lastAccess: Math.floor(maxAccessMs / 1000),
      tier: 0,
    };
  }

  // Run one full backfill pass. Fire-and-forget from startup; safe to re-run.
  async run(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastProgressLogMs = Date.now();
    this.log.info('Starting chunk cache index backfill', {
      baseDir: this.baseDir,
    });

    const limit = pLimit(this.walkConcurrency);

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (!this.running) {
        return;
      }

      // The data root is the indexed unit: aggregate it and stop descending.
      if (depth === DATA_ROOT_DEPTH) {
        const row = await this.aggregateDataRoot(
          dir,
          path.basename(dir),
          limit,
        );
        this.visited++;
        this.maybeLogProgress();
        if (row !== null) {
          this.buffer.push(row);
          if (this.buffer.length >= this.batchSize) {
            await this.flush();
          }
        }
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
            // Only directories lead to data roots; files above the data-root
            // depth are not chunk data.
            if (!entry.isDirectory()) {
              return;
            }
            await walk(path.join(dir, entry.name), depth + 1);
          }),
        );
      }
    };

    try {
      const resumeFrom = await this.loadCheckpoint();
      if (resumeFrom !== null) {
        this.log.info('Resuming chunk cache index backfill from checkpoint', {
          resumeFrom,
        });
      }

      // Top-level shard directories are the checkpoint granularity: each is
      // walked (in parallel) to completion, then recorded, so a restart re-does
      // at most one shard instead of the whole tree. Only the top level needs a
      // stable order for the resume comparison; within a shard, order is
      // irrelevant. Use codepoint comparison consistently for both sort and skip.
      let topEntries: fs.Dirent[];
      try {
        topEntries = await fs.promises.readdir(this.baseDir, {
          withFileTypes: true,
        });
      } catch (error: any) {
        this.log.warn('Backfill: base dir not accessible', {
          baseDir: this.baseDir,
          code: error?.code,
        });
        return;
      }

      const shards = topEntries
        .filter((entry) => entry.isDirectory())
        // Defence in depth: baseDir should already be the by-dataroot subtree,
        // but if it is ever pointed a level too high, refuse to walk the
        // symlink index (double-counting) or the metadata tree.
        .filter(
          (entry) =>
            entry.name !== 'by-absolute-offset' && entry.name !== 'metadata',
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      let completed = true;
      for (const shard of shards) {
        if (!this.running) {
          completed = false;
          break;
        }
        // Skip shards already completed in a prior run.
        if (resumeFrom !== null && shard.name <= resumeFrom) {
          continue;
        }
        await walk(path.join(this.baseDir, shard.name), 1);
        // Flush this shard's remaining rows, then advance the checkpoint — but
        // only if the shard finished cleanly (not aborted mid-walk by stop()),
        // so we never record a partially-processed shard as done.
        await this.flush();
        if (this.running) {
          await this.saveCheckpoint(shard.name);
        } else {
          completed = false;
        }
      }

      await this.flush();
      if (completed && this.running) {
        // Full pass done: clear the checkpoint so a future enable starts fresh.
        await this.clearCheckpoint();
      }
      this.log.info('Chunk cache index backfill complete', {
        dataRootsVisited: this.visited,
        chunkFilesVisited: this.chunkFilesVisited,
        backfilled: this.backfilled,
        aborted: !this.running,
        completed,
      });
    } catch (error: any) {
      this.log.warn('Chunk cache index backfill failed', {
        error: error?.message,
      });
    } finally {
      this.running = false;
    }
  }
}
