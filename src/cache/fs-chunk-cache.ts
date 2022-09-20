import fs from 'fs';
import { Readable } from 'stream';
import winston from 'winston';

import {
  fromB64Url,
  jsonChunkToMsgpackChunk,
  msgpackToJsonChunk,
  toB64Url,
} from '../lib/encoding.js';
import { sanityCheckChunk, validateChunk } from '../lib/validation.js';
import { ChunkSource, JsonChunk, JsonChunkCache } from '../types.js';

function chunkCacheDir(dataRoot: Buffer, relativeOffset: number) {
  const b64DataRoot = toB64Url(dataRoot);
  return `data/chunks/${b64DataRoot}/data/${relativeOffset}`;
}

function chunkCachePath(dataRoot: Buffer, relativeOffset: number) {
  return `${chunkCacheDir(dataRoot, relativeOffset)}/${relativeOffset}.msgpack`;
}

export class FsChunkCache implements ChunkSource, JsonChunkCache {
  private log: winston.Logger;
  private chunkSource: ChunkSource;

  constructor({
    log,
    chunkSource,
  }: {
    log: winston.Logger;
    chunkSource: ChunkSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
  }

  async has(dataRoot: Buffer, relativeOffset: number) {
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
    dataRoot: Buffer,
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
    dataRoot: Buffer,
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
        dataRoot: toB64Url(dataRoot),
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

  async getChunkByRelativeOrAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<JsonChunk> {
    try {
      const chunkPromise = this.get(dataRoot, relativeOffset).then((chunk) => {
        // Chunk is cached
        if (chunk) {
          this.log.info('Successfully fetched chunk from cache', {
            dataRoot: toB64Url(dataRoot),
            relativeOffset,
          });
          return chunk;
        }

        // Fetch from ChunkSource
        return this.chunkSource
          .getChunkByRelativeOrAbsoluteOffset(
            absoluteOffset,
            dataRoot,
            relativeOffset,
          )
          .then((chunk: JsonChunk) => {
            this.set(chunk, dataRoot, relativeOffset);
            return chunk;
          });
      });

      const chunk = await chunkPromise;
      sanityCheckChunk(chunk);

      await validateChunk(chunk, dataRoot, relativeOffset);

      return chunk;
    } catch (error: any) {
      this.log.error('Failed to fetch chunk', {
        absoluteOffset,
        dataRoot,
        relativeOffset,
        message: error.message,
      });
      throw error;
    }
  }

  async getChunkDataByRelativeOrAbsoluteOffset(
    absoluteOffset: number,
    dataRoot: Buffer,
    relativeOffset: number,
  ): Promise<Readable> {
    const { chunk } = await this.getChunkByRelativeOrAbsoluteOffset(
      absoluteOffset,
      dataRoot,
      relativeOffset,
    );
    const data = fromB64Url(chunk);
    return Readable.from(data);
  }
}
