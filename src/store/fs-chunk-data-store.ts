import fs from 'fs';
import winston from 'winston';

import { ChunkDataStore } from '../types.js';

export class FsChunkDataStore implements ChunkDataStore {
  private log: winston.Logger;
  private baseDir: string;

  constructor({ log, baseDir }: { log: winston.Logger; baseDir: string }) {
    this.log = log.child({ class: this.constructor.name });
    this.baseDir = baseDir;
  }

  private chunkDataDir(dataRoot: string) {
    return `${this.baseDir}/${dataRoot}/data/`;
  }

  private chunkDataPath(dataRoot: string, relativeOffset: number) {
    return `${this.chunkDataDir(dataRoot)}/${relativeOffset}`;
  }

  async has(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        this.chunkDataPath(dataRoot, relativeOffset),
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
  ): Promise<Buffer | undefined> {
    try {
      if (await this.has(dataRoot, relativeOffset)) {
        return await fs.promises.readFile(
          this.chunkDataPath(dataRoot, relativeOffset),
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

  async set(
    dataRoot: string,
    relativeOffset: number,
    data: Buffer,
  ): Promise<void> {
    try {
      await fs.promises.mkdir(this.chunkDataDir(dataRoot), {
        recursive: true,
      });
      await fs.promises.writeFile(
        this.chunkDataPath(dataRoot, relativeOffset),
        data,
      );
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
