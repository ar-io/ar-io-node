import fs from 'fs';
import { Readable } from 'stream';
import winston from 'winston';

import { toB64Url } from '../lib/encoding.js';
import {
  ChunkDataByRelativeOrAbsoluteOffsetSource,
  ChunkDataCache,
} from '../types.js';

function chunkCacheDir(dataRoot: Buffer) {
  const b64DataRoot = toB64Url(dataRoot);
  return `data/chunks/${b64DataRoot}/data/`;
}

function chunkCachePath(dataRoot: Buffer, relativeOffset: number) {
  return `${chunkCacheDir(dataRoot)}/${relativeOffset}`;
}

export class FsChunkCache
  implements ChunkDataByRelativeOrAbsoluteOffsetSource, ChunkDataCache
{
  private log: winston.Logger;
  private chunkSource: ChunkDataByRelativeOrAbsoluteOffsetSource;

  constructor({
    log,
    chunkSource,
  }: {
    log: winston.Logger;
    chunkSource: ChunkDataByRelativeOrAbsoluteOffsetSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
  }

  async hasChunkData(dataRoot: Buffer, relativeOffset: number) {
    try {
      await fs.promises.access(
        chunkCachePath(dataRoot, relativeOffset),
        fs.constants.F_OK,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async getChunkData(
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<Buffer | undefined> {
    try {
      if (await this.hasChunkData(dataRoot, relativeOffset)) {
        return await fs.promises.readFile(
          chunkCachePath(dataRoot, relativeOffset),
        );
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

  async setChunkData(
    data: Buffer,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<void> {
    try {
      await fs.promises.mkdir(chunkCacheDir(dataRoot), {
        recursive: true,
      });
      await fs.promises.writeFile(
        chunkCachePath(dataRoot, relativeOffset),
        data,
      );
      this.log.info('Successfully cached chunk data', {
        dataRoot: toB64Url(dataRoot),
        relativeOffset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk data in cache', {
        dataRoot: toB64Url(dataRoot),
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async getChunkDataByRelativeOrAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<Readable> {
    try {
      const chunkDataPromise = this.getChunkData(dataRoot, relativeOffset).then(
        async (chunkData) => {
          // Chunk is cached
          if (chunkData) {
            this.log.info('Successfully fetched chunk data from cache', {
              dataRoot: toB64Url(dataRoot),
              relativeOffset,
            });
            return chunkData;
          }

          // Fetch from ChunkSource
          return this.chunkSource.getChunkDataByRelativeOrAbsoluteOffset(
            absoluteOffset,
            dataRoot,
            relativeOffset,
          );
        },
      );
      const chunkData = await chunkDataPromise;
      return Readable.from(chunkData);
    } catch (error: any) {
      this.log.error('Failed to fetch chunk data', {
        absoluteOffset,
        dataRoot: toB64Url(dataRoot),
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
