import fs from 'fs';
import * as winston from 'winston';

import {
  jsonChunkToMsgpackChunk,
  msgpackToJsonChunk,
} from '../lib/encoding.js';
import { ChunkDataCache, JsonChunk } from '../types.js';

function chunkCachePath(dataRoot: string, relativeOffset: number) {
  return `data/chunks/${dataRoot}/data/${relativeOffset}`;
}

function chunkCacheDir(dataRoot: string, relativeOffset: number) {
  return `${chunkCachePath(
    dataRoot,
    relativeOffset,
  )}/${relativeOffset}.msgpack`;
}

export class FsChunkCache implements ChunkDataCache {
  private log: winston.Logger;

  constructor(log: winston.Logger) {
    this.log = log.child({ class: 'FsChunkCache' });
  }

  async has(dataRoot: string, relativeOffset: number) {
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

  async get(
    dataRoot: string,
    relativeOffset: number,
  ): Promise<JsonChunk | undefined> {
    try {
      if (await this.has(dataRoot, relativeOffset)) {
        const chunk = await fs.promises.readFile(
          chunkCachePath(dataRoot, relativeOffset),
        );
        return msgpackToJsonChunk(chunk);
      }
      return undefined;
    } catch (error: any) {
      this.log.error('Failed to fetch chunk from cache', {
        dataRoot,
        relativeOffset,
        message: error.message,
      });
      return undefined;
    }
  }

  async set(
    chunk: JsonChunk,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<void> {
    try {
      const chunkDir = chunkCacheDir(dataRoot, relativeOffset);
      await fs.promises.mkdir(chunkDir, {
        recursive: true,
      });
      const chunkData = jsonChunkToMsgpackChunk(chunk);
      await fs.promises.writeFile(chunkDir, chunkData);
    } catch (error: any) {
      this.log.error('Failed to set chunk in cache', {
        dataRoot,
        relativeOffset,
        message: error.message,
      });
    }
  }
}
