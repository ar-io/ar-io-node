/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';

import { ChunkData, ChunkDataCacheIndex, ChunkDataStore } from '../types.js';
import { CHUNK_DATA_CACHE_INDEX_UPDATE_ON_READ } from '../config.js';
import { currentUnixTimestamp } from '../lib/time.js';
import * as metrics from '../metrics.js';

export class FsChunkDataStore implements ChunkDataStore {
  private log: winston.Logger;
  private baseDir: string;
  // Absent => the eviction index feature is entirely off for this store, the
  // same way ReadThroughDataCache treats its contiguous cache index.
  private chunkDataCacheIndex?: ChunkDataCacheIndex;
  // Defaults to CHUNK_DATA_CACHE_INDEX_UPDATE_ON_READ; overridable so the
  // read-hook gate can be exercised in both states within one test process
  // (the config value is fixed at module load).
  private updateOnRead: boolean;

  constructor({
    log,
    baseDir,
    chunkDataCacheIndex,
    updateOnRead = CHUNK_DATA_CACHE_INDEX_UPDATE_ON_READ,
  }: {
    log: winston.Logger;
    baseDir: string;
    chunkDataCacheIndex?: ChunkDataCacheIndex;
    updateOnRead?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
    this.chunkDataCacheIndex = chunkDataCacheIndex;
    this.updateOnRead = updateOnRead;
  }

  // Record a freshly-written chunk in the eviction index (best-effort). Tier 0
  // = general. Fire-and-forget: the index is an eviction accelerator, never a
  // precondition for caching, so a failure here must not fail or delay the
  // chunk write that already succeeded.
  private recordCacheIndexEntry(dataRoot: string, size: number): void {
    if (this.chunkDataCacheIndex === undefined) {
      return;
    }
    this.chunkDataCacheIndex
      .saveChunkDataCacheEntry({
        dataRoot,
        size,
        lastWrite: currentUnixTimestamp(),
        tier: 0,
      })
      .catch((error: any) => {
        this.log.debug('Failed to record chunk cache index entry', {
          dataRoot,
          message: error?.message,
        });
      });
  }

  // Refresh a data root's recency in the eviction index on a cache hit. No-op
  // when the index isn't wired or update-on-read is disabled (FIFO mode).
  // Touches last_access only -- a read must never advance last_write, which is
  // the ingest-confirmation age floor.
  private touchCacheIndexEntry(dataRoot: string): void {
    if (this.chunkDataCacheIndex === undefined || !this.updateOnRead) {
      return;
    }
    this.chunkDataCacheIndex
      .touchChunkDataCacheEntry(dataRoot, currentUnixTimestamp(), 0)
      .catch((error: any) => {
        this.log.debug('Failed to touch chunk cache index entry', {
          dataRoot,
          message: error?.message,
        });
      });
  }

  private chunkDataRootDir(dataRoot: string) {
    const dataRootPrefix = `${dataRoot.substring(0, 2)}/${dataRoot.substring(
      2,
      4,
    )}`;
    return `${this.baseDir}/data/by-dataroot/${dataRootPrefix}/${dataRoot}`;
  }

  private chunkDataRootPath(dataRoot: string, relativeOffset: number) {
    return `${this.chunkDataRootDir(dataRoot)}/${relativeOffset}`;
  }

  private absoluteOffsetIndexDir(absoluteOffset: number) {
    const tb = Math.floor(absoluteOffset / 1e12); // Terabyte bucket
    const gb = Math.floor(absoluteOffset / 1e9) % 1000; // Gigabyte bucket
    return `${this.baseDir}/data/by-absolute-offset/${tb}/${gb}`;
  }

  private absoluteOffsetIndexPath(absoluteOffset: number) {
    return `${this.absoluteOffsetIndexDir(absoluteOffset)}/${absoluteOffset}`;
  }

  async has(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        this.chunkDataRootPath(dataRoot, relativeOffset),
        fs.constants.F_OK,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async get(
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkData | undefined> {
    try {
      if (await this.has(dataRoot, relativeOffset)) {
        const chunkPath = this.chunkDataRootPath(dataRoot, relativeOffset);
        const chunk = await fs.promises.readFile(chunkPath);

        // Self-heal poisoned cache entries: a zero-length chunk file is never
        // valid and, if served, would stall consumers that advance by chunk
        // length (re-requesting the same offset forever). Treat it as a miss
        // so the caller refetches and overwrites it.
        if (chunk.length === 0) {
          metrics.chunkZeroLengthTotal.inc({ stage: 'cache_read' });
          this.log.warn('Ignoring zero-length cached chunk; treating as miss', {
            dataRoot,
            relativeOffset,
          });
          return undefined;
        }

        const hash = crypto.createHash('sha256').update(chunk).digest();

        this.touchCacheIndexEntry(dataRoot);

        return {
          hash,
          chunk,
        };
      }
    } catch (error: any) {
      this.log.error('Failed to fetch chunk data from cache', {
        dataRoot,
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
    }

    return undefined;
  }

  // KNOWN GAP: absolute-offset hits do not refresh the eviction index's
  // last_access. This path is reached by absolute offset alone; the data root
  // it belongs to is only recoverable by readlink()ing the index entry and
  // parsing the target path, i.e. an extra syscall plus a path-format
  // dependency on every hit of a hot read path. Recency here is therefore
  // best-effort: a data root read exclusively through this index looks colder
  // than it is and may be evicted earlier under LRU. Acceptable because the
  // last_write age floor -- the correctness-bearing half -- is unaffected.
  async getByAbsoluteOffset(
    absoluteOffset: number,
  ): Promise<ChunkData | undefined> {
    try {
      const symlinkPath = this.absoluteOffsetIndexPath(absoluteOffset);
      const chunk = await fs.promises.readFile(symlinkPath); // Follows symlink

      // Self-heal poisoned entries (see get()): treat a zero-length chunk as a
      // miss so the caller refetches rather than serving invalid empty data.
      if (chunk.length === 0) {
        metrics.chunkZeroLengthTotal.inc({ stage: 'cache_read' });
        this.log.warn(
          'Ignoring zero-length cached chunk by absolute offset; treating as miss',
          { absoluteOffset },
        );
        return undefined;
      }

      const hash = crypto.createHash('sha256').update(chunk).digest();

      return {
        hash,
        chunk,
      };
    } catch (error: any) {
      // ENOENT is expected for cache miss, don't log it
      if (error.code !== 'ENOENT') {
        this.log.error('Failed to fetch chunk data by absolute offset', {
          absoluteOffset,
          message: error.message,
          stack: error.stack,
        });
      }
      return undefined;
    }
  }

  async del(dataRoot: string, relativeOffset: number): Promise<void> {
    try {
      await fs.promises.unlink(
        this.chunkDataRootPath(dataRoot, relativeOffset),
      );
    } catch (error: any) {
      // ENOENT = already gone (success). Propagate anything else so the GC
      // caller leaves the placement row intact and retries on the next sweep
      // rather than orphaning the on-disk bytes.
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Reclaim a data root's chunks, refusing any file that is not provably old
   * enough to evict.
   *
   * Deliberately NOT `rm -rf` on the directory. Eviction is authorised against
   * the index, and the index can lag reality in two ways that a directory-level
   * removal cannot see:
   *
   *  - a chunk can land between the evictor's index DELETE and this call, and
   *  - a chunk write whose index update failed leaves `last_write` stale.
   *
   * Both end with a fresh, possibly still-unconfirmed chunk inside a directory
   * the index believes is cold. Each file's own mtime is the ground truth for
   * when that chunk was written, so it is checked immediately before its own
   * unlink. A file that cannot be proven old is kept -- freeing less than hoped
   * is recoverable, destroying a chunk that was still propagating is not.
   *
   * A directory-level mtime check is NOT sufficient here and was tried:
   * overwriting an existing offset updates the file's mtime but never the
   * parent directory's, so a re-POSTed chunk would slip through.
   *
   * The cost is close to a wash -- `fs.rm(recursive)` already walks the
   * directory and unlinks each entry internally; this walk just also stats.
   *
   * `maxMtimeSeconds` omitted means "no floor", used by callers that are not
   * the evictor.
   *
   * `by-absolute-offset` symlinks pointing here are NOT removed: they are
   * reaped by SymlinkCleanupWorker, and a dangling one already reads as a cache
   * miss in getByAbsoluteOffset(). Removing the directory also races set()'s
   * mkdir -> writeFile; the ENOENT retry that closes that window is in set()
   * below, so an image predating it must not run the evictor.
   */
  async delDataRoot(
    dataRoot: string,
    maxMtimeSeconds?: number,
  ): Promise<{
    removedFiles: number;
    removedBytes: number;
    keptFiles: number;
  }> {
    const dir = this.chunkDataRootDir(dataRoot);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error: any) {
      // Already gone: nothing reclaimed, nothing at risk.
      if (error.code === 'ENOENT') {
        return {
          removedFiles: 0,
          removedBytes: 0,
          keptFiles: 0,
          failedFiles: 0,
        };
      }
      throw error;
    }

    let removedFiles = 0;
    let removedBytes = 0;
    // Deliberately withheld because it is newer than the floor. Expected.
    let keptFiles = 0;
    // Could not be removed: unreadable, unlinkable, or not a plain file. A
    // genuine fault, counted apart from keptFiles so it is never reported as
    // an age-floor refusal -- operators read that as working as designed.
    let failedFiles = 0;

    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`;
      // Only plain files are chunks. Anything else (a stray directory, a
      // symlink) is left alone rather than guessed at.
      if (!entry.isFile()) {
        failedFiles++;
        continue;
      }
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(fullPath);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          continue; // raced with another deleter; nothing to do
        }
        // Cannot establish this file's age, so cannot prove it is safe to
        // remove. Keep it, but as a fault rather than a floor refusal.
        failedFiles++;
        continue;
      }
      if (
        maxMtimeSeconds !== undefined &&
        Math.floor(stats.mtimeMs / 1000) > maxMtimeSeconds
      ) {
        keptFiles++;
        continue;
      }
      try {
        await fs.promises.unlink(fullPath);
        removedFiles++;
        removedBytes += stats.size;
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          continue;
        }
        failedFiles++;
      }
    }

    if (keptFiles === 0 && failedFiles === 0) {
      // Reap the directory itself. ~93% of data-root directories on a
      // production volume are empty because nothing ever did this, and that
      // is most of what makes the filesystem walk expensive.
      await fs.promises.rmdir(dir).catch(() => undefined);
    }

    return { removedFiles, removedBytes, keptFiles, failedFiles };
  }

  async set(
    dataRoot: string,
    relativeOffset: number,
    chunkData: ChunkData,
    absoluteOffset?: number,
  ): Promise<void> {
    // Never persist a zero-length chunk: it is invalid data and poisons the
    // cache, since has() would report a hit and get() would return an empty
    // buffer that stalls chunk-streaming consumers.
    if (chunkData.chunk.length === 0) {
      metrics.chunkZeroLengthTotal.inc({ stage: 'cache_write' });
      this.log.warn('Refusing to cache zero-length chunk', {
        dataRoot,
        relativeOffset,
        absoluteOffset,
      });
      return;
    }

    try {
      const chunkDataRootDir = this.chunkDataRootDir(dataRoot);
      await fs.promises.mkdir(chunkDataRootDir, { recursive: true });

      const chunkPath = this.chunkDataRootPath(dataRoot, relativeOffset);
      try {
        await fs.promises.writeFile(chunkPath, chunkData.chunk);
      } catch (error: any) {
        // The directory can be removed between the mkdir above and this write:
        // nothing reaps empty data-root directories today, but eviction that
        // works at data-root granularity will, and the resulting ENOENT would
        // otherwise be swallowed by the outer catch -- silently dropping a
        // chunk the caller believes was cached. Recreate and retry once.
        if (error.code !== 'ENOENT') {
          throw error;
        }
        await fs.promises.mkdir(chunkDataRootDir, { recursive: true });
        await fs.promises.writeFile(chunkPath, chunkData.chunk);
      }

      // The bytes are durably on disk at this point. Record them in the
      // eviction index before (and independently of) the symlink step, so a
      // symlink failure can't leave indexed-but-unwritten or written-but-
      // unindexed state depending on ordering.
      this.recordCacheIndexEntry(dataRoot, chunkData.chunk.length);

      // If absoluteOffset provided, create symlink in by-absolute-offset index
      if (absoluteOffset !== undefined) {
        await this.createAbsoluteOffsetSymlink(
          dataRoot,
          relativeOffset,
          absoluteOffset,
        );
      }

      this.log.info('Successfully cached chunk data', {
        dataRoot,
        relativeOffset,
        absoluteOffset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk data in cache:', {
        dataRoot,
        relativeOffset,
        absoluteOffset,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  /**
   * Point the absolute-offset index at a chunk, creating or updating the link.
   *
   * The entry is never momentarily absent: the common case (an existing link
   * already pointing at this target) is a no-op, and a genuine retarget is
   * applied with an atomic rename. A concurrent reader therefore always
   * resolves either the previous target or the new one. The index is
   * best-effort -- failures are logged and swallowed so they cannot prevent
   * the chunk itself from being cached.
   */
  private async createAbsoluteOffsetSymlink(
    dataRoot: string,
    relativeOffset: number,
    absoluteOffset: number,
  ): Promise<void> {
    try {
      const indexDir = this.absoluteOffsetIndexDir(absoluteOffset);
      await fs.promises.mkdir(indexDir, { recursive: true });

      const symlinkPath = this.absoluteOffsetIndexPath(absoluteOffset);
      const targetPath = path.relative(
        indexDir,
        this.chunkDataRootPath(dataRoot, relativeOffset),
      );

      // Link directly rather than unlinking first. Unlinking opens a window in
      // which the index entry does not exist: a concurrent read of this offset
      // sees ENOENT, treats it as a cache miss, and refetches data that is
      // already on disk. Concurrent writers for the same offset resolve to the
      // same target, so an EEXIST whose target already matches is a no-op, not
      // an error -- which is what made this the hottest error in the log.
      // A genuinely different target still gets replaced: that is the
      // "allows updating" case the unlink was there for.
      try {
        await fs.promises.symlink(targetPath, symlinkPath);
      } catch (error: any) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        const existing = await fs.promises
          .readlink(symlinkPath)
          .catch(() => undefined);
        if (existing === targetPath) {
          return;
        }
        // Replace atomically. Unlinking first would reintroduce the very
        // window this change exists to close: rename() over an existing path
        // is atomic within a filesystem, so a concurrent read always sees
        // either the old link or the new one, never nothing. The temporary
        // name is unique so concurrent replacements cannot collide on it.
        const tmpPath = `${symlinkPath}.tmp-${crypto
          .randomBytes(8)
          .toString('hex')}`;
        await fs.promises.symlink(targetPath, tmpPath);
        try {
          await fs.promises.rename(tmpPath, symlinkPath);
        } catch (renameError: any) {
          await fs.promises.unlink(tmpPath).catch(() => undefined);
          throw renameError;
        }
      }
    } catch (error: any) {
      this.log.error('Failed to create absolute offset symlink', {
        dataRoot,
        relativeOffset,
        absoluteOffset,
        message: error.message,
        stack: error.stack,
      });
      // Don't throw - symlink failure shouldn't prevent caching
    }
  }
}
