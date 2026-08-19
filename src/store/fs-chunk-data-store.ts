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

import { ChunkData, ChunkDataStore } from '../types.js';
import * as metrics from '../metrics.js';

export class FsChunkDataStore implements ChunkDataStore {
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
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
      await fs.promises.writeFile(chunkPath, chunkData.chunk);

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
        await fs.promises.unlink(symlinkPath);
        await fs.promises.symlink(targetPath, symlinkPath);
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
