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

import { toB64Url } from '../lib/encoding.js';
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

  private chunkHashDir(hash: Buffer) {
    const b64hash = toB64Url(hash);
    const hashPrefix = `${b64hash.substring(0, 2)}/${b64hash.substring(2, 4)}`;
    return `${this.baseDir}/data/by-hash/${hashPrefix}`;
  }

  private chunkHashPath(hash: Buffer) {
    const b64hash = toB64Url(hash);
    return `${this.chunkHashDir(hash)}/${b64hash}`;
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
        const chunk = await fs.promises.readFile(
          this.chunkDataRootPath(dataRoot, relativeOffset),
        );
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

  async set(
    dataRoot: string,
    relativeOffset: number,
    chunkData: ChunkData,
  ): Promise<void> {
    try {
      const chunkDataRootDir = this.chunkDataRootDir(dataRoot);
      await fs.promises.mkdir(chunkDataRootDir, { recursive: true });
      await fs.promises.mkdir(this.chunkHashDir(chunkData.hash), {
        recursive: true,
      });

      const chunkHashPath = this.chunkHashPath(chunkData.hash);
      await fs.promises.writeFile(chunkHashPath, chunkData.chunk);
      const targetPath = path.relative(
        `${process.cwd()}/${chunkDataRootDir}`,
        `${process.cwd()}/${chunkHashPath}`,
      );

      const linkPath = this.chunkDataRootPath(dataRoot, relativeOffset);

      let linkPathExists = true;

      try {
        await fs.promises.stat(linkPath);
      } catch {
        linkPathExists = false;
        this.log.debug('Chunk data not yet cached', {
          dataRoot,
          relativeOffset,
        });
      }

      if (!linkPathExists) {
        await fs.promises.symlink(targetPath, linkPath);
      }

      this.log.info('Successfully cached chunk data', {
        dataRoot,
        relativeOffset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk data in cache:', {
        dataRoot,
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}
