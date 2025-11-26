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

  async set(
    dataRoot: string,
    relativeOffset: number,
    chunkData: ChunkData,
    absoluteOffset?: number,
  ): Promise<void> {
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

      // Remove existing symlink if present (allows updating)
      try {
        await fs.promises.unlink(symlinkPath);
      } catch {
        // Ignore if doesn't exist
      }

      await fs.promises.symlink(targetPath, symlinkPath);
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

  async cleanupDeadSymlinks(): Promise<number> {
    let cleanedCount = 0;
    const baseIndexDir = `${this.baseDir}/data/by-absolute-offset`;

    try {
      // Check if the index directory exists
      try {
        await fs.promises.access(baseIndexDir);
      } catch {
        return 0; // No index directory yet
      }

      // Walk TB bucket directories
      const tbBuckets = await fs.promises.readdir(baseIndexDir);
      for (const tb of tbBuckets) {
        const tbDir = `${baseIndexDir}/${tb}`;
        const stat = await fs.promises.stat(tbDir);
        if (!stat.isDirectory()) continue;

        // Walk GB bucket directories
        const gbBuckets = await fs.promises.readdir(tbDir);
        for (const gb of gbBuckets) {
          const gbDir = `${tbDir}/${gb}`;
          const gbStat = await fs.promises.stat(gbDir);
          if (!gbStat.isDirectory()) continue;

          // Check each symlink
          const entries = await fs.promises.readdir(gbDir);
          for (const entry of entries) {
            const symlinkPath = `${gbDir}/${entry}`;
            try {
              const linkStat = await fs.promises.lstat(symlinkPath);
              if (linkStat.isSymbolicLink()) {
                // Check if target exists
                try {
                  await fs.promises.stat(symlinkPath); // Follows symlink
                } catch {
                  // Target doesn't exist - dead symlink
                  await fs.promises.unlink(symlinkPath);
                  cleanedCount++;
                }
              }
            } catch {
              // Error checking symlink, skip
            }
          }
        }
      }
    } catch (error: any) {
      this.log.error('Error during dead symlink cleanup', {
        message: error.message,
        stack: error.stack,
      });
    }

    if (cleanedCount > 0) {
      this.log.info('Cleaned up dead symlinks', { count: cleanedCount });
    }

    return cleanedCount;
  }
}
