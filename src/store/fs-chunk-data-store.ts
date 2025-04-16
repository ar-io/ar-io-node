/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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

      let linkPathExists = false;

      try {
        await fs.promises.stat(linkPath);
      } catch {
        linkPathExists = true;
        this.log.debug('Chunk data already cached', {
          dataRoot,
          relativeOffset,
        });
      }

      if (!linkPathExists) {
        await fs.promises.symlink(targetPath, linkPath);
        this.log.info('Successfully cached chunk data', {
          dataRoot,
          relativeOffset,
        });
      }
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
