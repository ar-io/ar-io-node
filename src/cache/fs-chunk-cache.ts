import fs from 'fs';
import winston from 'winston';

import {
  jsonChunkToMsgpackChunk,
  msgpackToJsonChunk,
} from '../lib/encoding.js';
import { JsonChunk, JsonChunkCache } from '../types.js';

function chunkCacheDir(dataRoot: string, relativeOffset: number) {
  return `data/chunks/${dataRoot}/data/${relativeOffset}`;
}

function chunkCachePath(dataRoot: string, relativeOffset: number) {
  return `${chunkCacheDir(dataRoot, relativeOffset)}/${relativeOffset}.msgpack`;
}

export class FsChunkCache implements JsonChunkCache {
  private log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: this.constructor.name });
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
      await fs.promises.mkdir(chunkCacheDir(dataRoot, relativeOffset), {
        recursive: true,
      });
      const msgpackChunk = jsonChunkToMsgpackChunk(chunk);
      await fs.promises.writeFile(
        chunkCachePath(dataRoot, relativeOffset),
        msgpackChunk,
      );
      this.log.info('Successfully cached chunk', {
        dataRoot,
        relativeOffset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk in cache', {
        dataRoot,
        relativeOffset,
        message: error.message,
      });
    }
  }
}
