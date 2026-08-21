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
import { currentUnixTimestamp } from '../lib/time.js';

// Bound work per sweep so a large backlog is reclaimed over several sweeps
// rather than one unbounded pass; the next sweep resumes.
const MAX_BATCHES_PER_SWEEP = 50;

// Concurrent data-root unlinks per batch comes from
// config.CHUNK_DATA_CACHE_INDEX_UNLINK_CONCURRENCY, derived from
// UV_THREADPOOL_SIZE. Deliberately NOT a fixed constant: each fs.rm(recursive)
// holds a libuv thread for its whole walk, and the evictor runs precisely when
// the device is saturated, so taking the entire pool converts "disk full" into
// "disk full and chunk reads time out".

/**
 * One eviction candidate: a whole data root's worth of cached chunks.
 *
 * `lastWrite` is load-bearing, not informational -- it is what lets the evictor
 * re-check the age floor itself instead of trusting the SQL WHERE clause. See
 * {@link ChunkDataCacheEvictor} for why that second check exists.
 */
export interface ChunkDataCacheEvictionCandidate {
  dataRoot: string;
  size: number;
  chunkCount: number;
  lastWrite: number;
}

/**
 * The slice of the chunk data cache index this worker needs. Declared
 * structurally so the evictor can be unit tested against an in-memory stand-in.
 */
export interface ChunkDataCacheEvictorIndex {
  countChunkDataCacheEntries(): Promise<number>;
  sumChunkDataCacheBytes(): Promise<number>;
  // `maxLastWrite` is the age floor: only data roots whose newest chunk write
  // is at or before it may be returned. Ordered tier ASC, lastAccess ASC.
  selectChunkDataCacheEvictionCandidates(
    maxLastWrite: number,
    limit: number,
  ): Promise<ChunkDataCacheEvictionCandidate[]>;
  // Returns the data roots whose row was actually deleted -- the caller unlinks
  // those and only those. `maxLastWrite` re-applies the age floor at delete
  // time, so a data root written to between selection and deletion is not
  // returned and therefore never unlinked.
  deleteChunkDataCacheEntries(
    dataRoots: string[],
    maxLastWrite: number,
  ): Promise<string[]>;
}

/**
 * The store primitive this worker needs. Chunk eviction is data-root granular:
 * the unit reclaimed is the whole `by-dataroot/<prefix>/<dataRoot>` directory,
 * not an individual chunk file, so `del(dataRoot, relativeOffset)` is the wrong
 * shape (it would need the offsets, which the index does not store).
 *
 * Contract assumed of `delDataRoot`: remove the data root's directory
 * recursively; a missing directory is success (ENOENT tolerated); any other
 * error propagates so the caller can log it and let the reconciler heal.
 */
export interface ChunkDataRootStore {
  // Reclaims a data root's chunks, refusing any file newer than
  // `maxMtimeSeconds` -- the age floor, handed down to the filesystem so it is
  // enforced against each file's own mtime rather than against the index. The
  // byte count is what was actually unlinked, so the evictor reports what the
  // disk really gave back.
  delDataRoot(
    dataRoot: string,
    maxMtimeSeconds?: number,
  ): Promise<{
    removedFiles: number;
    removedBytes: number;
    keptFiles: number;
    failedFiles: number;
  }>;
}

/**
 * Disk-pressure evictor for the chunk data cache, driven by the SQLite cleanup
 * index instead of a filesystem walk. When usage on the cache filesystem
 * crosses the high watermark (or free space drops below the min-free floor), it
 * queries the index for the coldest data roots and reclaims them -- deleting the
 * index rows, then unlinking the data-root directories -- until usage recovers
 * below the low watermark or there is nothing left it is allowed to evict.
 *
 * `statfs` remains authoritative for "how full" (safety); the index only decides
 * "which data roots" (selection). Index drift is therefore harmless: a stale row
 * just unlinks a missing directory (ENOENT-ignored), and the FS reconciler
 * re-seeds rows for untracked chunks.
 *
 * Three things separate this from the contiguous data cache evictor:
 *
 * 1. AGE FLOOR. The contiguous evictor has none. This one must: a chunk written
 *    for an in-flight upload has to survive until its placement confirms, and
 *    evicting it early breaks propagation SILENTLY -- no error, just a data root
 *    that can never be served whole again. The floor is applied in the index
 *    query (`maxLastWrite`) AND re-checked here on every candidate, because a
 *    query that quietly stops filtering would otherwise fail invisibly.
 * 2. SIZE AWARE. Data-root chunk counts are extremely skewed (p50 ~2 chunks,
 *    max ~11k; the top 1% of data roots hold over half of all chunks). Evicting
 *    a fixed number of rows would repeatedly reclaim half-megabyte data roots
 *    and free nothing, so a batch accumulates candidates until it reaches a byte
 *    target and then stops.
 * 3. DATA-ROOT GRANULAR. The unit unlinked is a directory, via
 *    {@link ChunkDataRootStore.delDataRoot}.
 */
export class ChunkDataCacheEvictor {
  private log: Logger;
  private chunkDataStore: ChunkDataRootStore;
  private cacheIndex: ChunkDataCacheEvictorIndex;
  private usagePath: string;
  private lowWatermarkPercent: number;
  private highWatermarkPercent: number;
  private minFreeBytes: number;
  private intervalMs: number;
  private batchSize: number;
  private unlinkConcurrency: number;
  private minAgeSeconds: number;
  private targetBytes: number;

  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;

  constructor({
    log,
    chunkDataStore,
    cacheIndex,
    usagePath,
    lowWatermarkPercent = config.CHUNK_DATA_CACHE_LOW_WATERMARK_PERCENT,
    highWatermarkPercent = config.CHUNK_DATA_CACHE_HIGH_WATERMARK_PERCENT,
    minFreeBytes = config.CHUNK_DATA_CACHE_MIN_FREE_BYTES,
    intervalMs = config.CHUNK_DATA_CACHE_INDEX_EVICTION_INTERVAL_MS,
    batchSize = config.CHUNK_DATA_CACHE_INDEX_EVICTION_BATCH_SIZE,
    unlinkConcurrency = config.CHUNK_DATA_CACHE_INDEX_UNLINK_CONCURRENCY,
    minAgeSeconds = config.CHUNK_DATA_CACHE_INDEX_MIN_AGE_SECONDS,
    targetBytes = config.CHUNK_DATA_CACHE_INDEX_EVICTION_TARGET_BYTES,
  }: {
    log: Logger;
    chunkDataStore: ChunkDataRootStore;
    cacheIndex: ChunkDataCacheEvictorIndex;
    usagePath: string;
    lowWatermarkPercent?: number;
    highWatermarkPercent?: number;
    minFreeBytes?: number;
    intervalMs?: number;
    batchSize?: number;
    unlinkConcurrency?: number;
    minAgeSeconds?: number;
    targetBytes?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkDataStore = chunkDataStore;
    this.cacheIndex = cacheIndex;
    this.usagePath = usagePath;
    this.lowWatermarkPercent = lowWatermarkPercent;
    this.highWatermarkPercent = highWatermarkPercent;
    this.minFreeBytes = minFreeBytes;
    this.intervalMs = intervalMs;
    this.batchSize = Math.max(1, batchSize);
    this.unlinkConcurrency = Math.max(1, unlinkConcurrency);
    this.minAgeSeconds = Math.max(0, minAgeSeconds);
    this.targetBytes = Math.max(0, targetBytes);
  }

  start(): void {
    if (this.timer !== undefined) {
      return;
    }
    // Announce the effective age floor once at startup. It is derived, not
    // configured, so an operator cannot read it off the environment -- and it
    // is the one setting here whose failure mode is silent data loss rather
    // than a full disk. Surfacing it makes a misconfigured ingest timeout
    // visible at boot instead of after chunks have already gone missing.
    this.log.info('Starting chunk data cache index evictor', {
      usagePath: this.usagePath,
      minAgeSeconds: this.minAgeSeconds,
      lowWatermarkPercent: this.lowWatermarkPercent,
      highWatermarkPercent: this.highWatermarkPercent,
      minFreeBytes: this.minFreeBytes,
      batchSize: this.batchSize,
      targetBytes: this.targetBytes,
      intervalMs: this.intervalMs,
    });
    if (this.minAgeSeconds === 0) {
      this.log.warn(
        'Chunk data cache eviction has NO age floor; a chunk can be evicted immediately after it is written. This is only safe when the optimistic chunk ingest cache is disabled.',
      );
    }
    // Both pressure triggers default to 0, i.e. disabled. With neither set,
    // overPressure() can never be true and this worker will never evict a
    // byte -- while the write and read hooks still pay their full cost. That
    // combination looks identical to a healthy idle evictor in the logs, so
    // say so once at startup rather than leaving an operator to infer it.
    if (this.highWatermarkPercent <= 0 && this.minFreeBytes <= 0) {
      this.log.warn(
        'Chunk data cache index evictor has no pressure trigger configured and will never evict; set CHUNK_DATA_CACHE_HIGH_WATERMARK_PERCENT and/or CHUNK_DATA_CACHE_MIN_FREE_BYTES',
        {
          highWatermarkPercent: this.highWatermarkPercent,
          minFreeBytes: this.minFreeBytes,
        },
      );
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

  /**
   * Pick the data roots to evict from one candidate page.
   *
   * Enforces the age floor a second time (see the class comment) and stops
   * accumulating as soon as the batch's byte target is met, so one very large
   * data root ends the batch while a run of tiny ones does not.
   */
  private selectBatch(
    candidates: ChunkDataCacheEvictionCandidate[],
    maxLastWrite: number,
  ): { selected: ChunkDataCacheEvictionCandidate[]; skippedByFloor: number } {
    const selected: ChunkDataCacheEvictionCandidate[] = [];
    let selectedBytes = 0;
    let skippedByFloor = 0;

    for (const candidate of candidates) {
      // Belt and braces. The index query already filters on the floor; if it
      // ever stops doing so the damage is silent and unrecoverable, so refuse
      // the row here too rather than trusting the WHERE clause.
      if (candidate.lastWrite > maxLastWrite) {
        skippedByFloor++;
        metrics.chunkCacheIndexSkippedFloorTotal.inc();
        continue;
      }

      selected.push(candidate);
      selectedBytes += candidate.size;
      if (this.targetBytes > 0 && selectedBytes >= this.targetBytes) {
        break;
      }
    }

    return { selected, skippedByFloor };
  }

  /**
   * Log the right thing when the index returns no candidates while the disk is
   * still over pressure. "Nothing left to evict" and "everything left is too
   * young to evict" look identical at the query, but only the first is a
   * problem: conflating them sends an operator hunting index drift that is not
   * there. A count that cannot be read is treated as the benign case -- the
   * drift warning is only worth emitting when the index is provably empty.
   */
  private async logEmptyCandidates(
    usedPercent: number | undefined,
    maxLastWrite: number,
  ): Promise<void> {
    const remainingRows = await this.cacheIndex
      .countChunkDataCacheEntries()
      .catch(() => undefined);

    if (remainingRows === 0) {
      this.log.warn(
        'Chunk cache index drained but still over pressure; untracked chunks may need the FS reconciler',
        { usedPercent },
      );
      return;
    }

    this.log.info(
      'All remaining chunk cache index entries are inside the age floor; deferring eviction',
      {
        usedPercent,
        remainingRows,
        minAgeSeconds: this.minAgeSeconds,
        maxLastWrite,
      },
    );
  }

  async sweep(): Promise<void> {
    if (this.sweeping) {
      return; // never overlap sweeps
    }
    this.sweeping = true;
    try {
      // Refresh observability gauges each sweep.
      try {
        metrics.chunkCacheIndexEntriesGauge.set(
          await this.cacheIndex.countChunkDataCacheEntries(),
        );
        metrics.chunkCacheIndexBytesGauge.set(
          await this.cacheIndex.sumChunkDataCacheBytes(),
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

      this.log.info('Chunk data cache over pressure; evicting via index', {
        usedPercent: usage.usedPercent,
        freeBytes: usage.freeBytes,
        lowWatermarkPercent: this.lowWatermarkPercent,
        highWatermarkPercent: this.highWatermarkPercent,
        minAgeSeconds: this.minAgeSeconds,
        targetBytes: this.targetBytes,
      });

      let evictedDataRoots = 0;
      let evictedChunks = 0;
      let bytesFreed = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_SWEEP; batch++) {
        // Recomputed per batch: a long sweep must not keep using a cutoff that
        // has gone stale, and a fresh cutoff can only ever be more permissive.
        //
        // Must use the SAME clock as the write hook. currentUnixTimestamp()
        // rounds (`.toFixed(0)`) rather than flooring, so a chunk written at
        // T.7s is stamped T+1. Flooring here would compute T and treat that
        // row as written in the future, hiding it from eviction for up to a
        // second. Invisible behind an hours-long floor, but wrong, and it
        // makes anything driving the evictor with a small floor
        // nondeterministic.
        const nowSeconds = currentUnixTimestamp();
        const maxLastWrite = nowSeconds - this.minAgeSeconds;

        const candidates =
          await this.cacheIndex.selectChunkDataCacheEvictionCandidates(
            maxLastWrite,
            this.batchSize,
          );
        if (candidates.length === 0) {
          await this.logEmptyCandidates(usage.usedPercent, maxLastWrite);
          break;
        }

        const { selected, skippedByFloor } = this.selectBatch(
          candidates,
          maxLastWrite,
        );
        if (skippedByFloor > 0) {
          this.log.warn(
            'Eviction candidates were inside the age floor; the index query should have excluded them',
            { skippedByFloor, maxLastWrite, minAgeSeconds: this.minAgeSeconds },
          );
        }
        if (selected.length === 0) {
          await this.logEmptyCandidates(usage.usedPercent, maxLastWrite);
          break;
        }

        // Delete all the index rows in one transaction; it returns the data
        // roots actually removed (guards against a row deleted/re-cached
        // between the select and now), and only those get unlinked.
        const deletedDataRoots =
          await this.cacheIndex.deleteChunkDataCacheEntries(
            selected.map((candidate) => candidate.dataRoot),
            maxLastWrite,
          );

        // Remove the directories, then account for what was ACTUALLY removed.
        //
        // The index is not authoritative for reclaimed bytes. Every other
        // reclaimer on a gateway -- the ingest GC, the filesystem-walk worker,
        // an operator's manual sweep -- unlinks chunks without touching this
        // index, so a row can outlive its files. Those rows are the coldest
        // (last_access froze when the files vanished), so they sort to the
        // front of every batch. Booking their bytes as freed would report
        // gigabytes of progress that `df` never shows, which is precisely the
        // failure this index exists to make visible.
        const unlinkLimit = pLimit(this.unlinkConcurrency);
        const removals = await Promise.all(
          deletedDataRoots.map((dataRoot) =>
            unlinkLimit(() =>
              this.chunkDataStore
                .delDataRoot(dataRoot, maxLastWrite)
                .catch((error: any) => {
                  // Genuinely failed (EACCES, EIO, ...) rather than absent.
                  // Not a reclaim, and worth seeing: at info level the whole
                  // feature could otherwise fail silently.
                  this.log.warn('Failed to reclaim evicted data root', {
                    dataRoot,
                    error: error?.message,
                  });
                  return {
                    removedFiles: 0,
                    removedBytes: 0,
                    keptFiles: 0,
                    failedFiles: 0,
                  };
                })
                .then((result) => ({ dataRoot, result })),
            ),
          ),
        );

        let missingThisBatch = 0;
        for (const { dataRoot, result } of removals) {
          if (result.failedFiles > 0) {
            // Not an age-floor refusal: something could not be read or
            // unlinked. Distinct label so a permission or I/O fault is never
            // mistaken for the guard working as designed.
            metrics.chunkCacheIndexUnlinkRefusedTotal.inc({
              reason: 'unremovable',
            });
            this.log.warn('Could not remove some chunks during eviction', {
              dataRoot,
              failedFiles: result.failedFiles,
            });
          }
          if (result.keptFiles > 0) {
            // Files inside the age floor survived. Their row is already gone,
            // so those bytes are untracked until the next write to this data
            // root recreates the row or the reconciler re-seeds it. That is
            // the direction to fail in: an untracked chunk is merely not an
            // eviction candidate, whereas a destroyed one is unrecoverable.
            metrics.chunkCacheIndexUnlinkRefusedTotal.inc({
              reason: 'inside_age_floor',
            });
            this.log.debug('Kept chunks inside the age floor during eviction', {
              dataRoot,
              keptFiles: result.keptFiles,
              removedFiles: result.removedFiles,
            });
          }
          if (result.removedFiles === 0) {
            // Nothing on disk: the row outlived its files, which every other
            // reclaimer on the box can cause. The row is gone either way --
            // the useful half -- so the index self-heals as these are found.
            if (result.keptFiles === 0 && result.failedFiles === 0) {
              missingThisBatch++;
              metrics.chunkCacheIndexEvictedMissingTotal.inc();
            }
            continue;
          }
          // Booked from what the filesystem actually gave back, not from what
          // the index claimed the data root was worth.
          evictedDataRoots++;
          evictedChunks += result.removedFiles;
          bytesFreed += result.removedBytes;
          metrics.chunkCacheIndexEvictedTotal.inc(
            { reason: 'disk_pressure' },
            result.removedFiles,
          );
          metrics.chunkCacheIndexEvictedBytesTotal.inc(result.removedBytes);
        }
        if (missingThisBatch === removals.length && removals.length > 0) {
          // A whole batch of rows with nothing behind them. Harmless once, but
          // a persistent pattern means the index has drifted badly and the
          // evictor is doing no useful work while appearing busy.
          this.log.warn(
            'Chunk cache eviction batch freed nothing; every row selected was already absent from disk',
            { batchSize: removals.length, usedPercent: usage.usedPercent },
          );
        }

        usage = await this.diskUsage();
        if (usage === undefined) {
          break;
        }
        if (this.recovered(usage.usedPercent, usage.freeBytes)) {
          break;
        }
      }

      this.log.info('Chunk index eviction sweep complete', {
        evictedDataRoots,
        evictedChunks,
        bytesFreed,
        usedPercent: usage?.usedPercent,
      });
    } catch (error: unknown) {
      this.log.warn('Chunk index eviction sweep failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.sweeping = false;
    }
  }
}
