/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';

import { fromMsgpack, toB64Url, toMsgpack } from '../lib/encoding.js';
import { ChunkMetadata, ChunkMetadataStore } from '../types.js';

export class FsChunkMetadataStore implements ChunkMetadataStore {
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
  }

  private chunkMetadataDir(dataRoot: string) {
    const dataRootPrefix = `${dataRoot.substring(0, 2)}/${dataRoot.substring(
      2,
      4,
    )}`;
    return `${this.baseDir}/${dataRootPrefix}/metadata/`;
  }

  private chunkMetadataPath(dataRoot: string, relativeOffset: number) {
    return `${this.chunkMetadataDir(dataRoot)}/${relativeOffset}`;
  }

  private absoluteOffsetIndexDir(absoluteOffset: number) {
    const tb = Math.floor(absoluteOffset / 1e12); // Terabyte bucket
    const gb = Math.floor(absoluteOffset / 1e9) % 1000; // Gigabyte bucket
    return `${this.baseDir}/by-absolute-offset/${tb}/${gb}`;
  }

  private absoluteOffsetIndexPath(absoluteOffset: number) {
    return `${this.absoluteOffsetIndexDir(absoluteOffset)}/${absoluteOffset}`;
  }

  async has(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        this.chunkMetadataPath(dataRoot, relativeOffset),
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
  ): Promise<ChunkMetadata | undefined> {
    try {
      if (await this.has(dataRoot, relativeOffset)) {
        const msgpack = await fs.promises.readFile(
          this.chunkMetadataPath(dataRoot, relativeOffset),
        );
        return fromMsgpack(msgpack) as ChunkMetadata;
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
  ): Promise<ChunkMetadata | undefined> {
    try {
      const symlinkPath = this.absoluteOffsetIndexPath(absoluteOffset);
      const msgpack = await fs.promises.readFile(symlinkPath); // Follows symlink
      return fromMsgpack(msgpack) as ChunkMetadata;
    } catch (error: any) {
      // ENOENT is expected for cache miss, don't log it
      if (error.code !== 'ENOENT') {
        this.log.error('Failed to fetch chunk metadata by absolute offset', {
          absoluteOffset,
          message: error.message,
          stack: error.stack,
        });
      }
      return undefined;
    }
  }

  async set(
    chunkMetadata: ChunkMetadata,
    absoluteOffset?: number,
  ): Promise<void> {
    const { data_root, offset } = chunkMetadata;
    const dataRoot = toB64Url(data_root);
    try {
      await fs.promises.mkdir(this.chunkMetadataDir(dataRoot), {
        recursive: true,
      });
      const msgpack = toMsgpack(chunkMetadata);
      await fs.promises.writeFile(
        this.chunkMetadataPath(toB64Url(data_root), offset),
        msgpack,
      );

      // If absoluteOffset provided, create symlink in by-absolute-offset index
      if (absoluteOffset !== undefined) {
        await this.createAbsoluteOffsetSymlink(
          dataRoot,
          offset,
          absoluteOffset,
        );
      }

      this.log.info('Successfully cached chunk metadata', {
        dataRoot,
        relativeOffset: offset,
        absoluteOffset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk metadata in cache:', {
        dataRoot,
        relativeOffset: offset,
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
        this.chunkMetadataPath(dataRoot, relativeOffset),
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
    const baseIndexDir = `${this.baseDir}/by-absolute-offset`;

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
