import fs from 'fs';
import { Readable } from 'stream';
import winston from 'winston';

import {
  fromB64Url,
  fromMsgpack,
  toB64Url,
  toMsgpack,
} from '../lib/encoding.js';
import {
  ChunkByAbsoluteOrRelativeOffsetSource,
  ChunkDataByAbsoluteOrRelativeOffsetSource,
  ChunkDataCache,
  ChunkMetadata,
  ChunkMetadataByAbsoluteOrRelativeOffsetSource,
} from '../types.js';

function chunkMetadataCacheDir(dataRoot: string) {
  return `data/chunks/${dataRoot}/metadata/`;
}

function chunkMetadataCachePath(dataRoot: string, relativeOffset: number) {
  return `${chunkMetadataCacheDir(dataRoot)}/${relativeOffset}`;
}

function chunkDataCacheDir(dataRoot: string) {
  return `data/chunks/${dataRoot}/data/`;
}

function chunkDataCachePath(dataRoot: string, relativeOffset: number) {
  return `${chunkDataCacheDir(dataRoot)}/${relativeOffset}`;
}

// TODO decouple read through source and cache
// TODO rename to include something about being a read through cache
export class FsChunkCache
  implements ChunkDataByAbsoluteOrRelativeOffsetSource, ChunkDataCache
{
  private log: winston.Logger;
  private chunkSource: ChunkDataByAbsoluteOrRelativeOffsetSource;

  constructor({
    log,
    chunkSource,
  }: {
    log: winston.Logger;
    chunkSource: ChunkDataByAbsoluteOrRelativeOffsetSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
  }

  async hasChunkData(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        chunkDataCachePath(dataRoot, relativeOffset),
        fs.constants.F_OK,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async getChunkData(
    dataRoot: string,
    relativeOffset: number,
  ): Promise<Buffer | undefined> {
    try {
      if (await this.hasChunkData(dataRoot, relativeOffset)) {
        return await fs.promises.readFile(
          chunkDataCachePath(dataRoot, relativeOffset),
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
    data: Readable,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<void> {
    try {
      await fs.promises.mkdir(chunkDataCacheDir(dataRoot), {
        recursive: true,
      });
      await fs.promises.writeFile(
        chunkDataCachePath(dataRoot, relativeOffset),
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

  async getChunkDataByAbsoluteOrRelativeOffset(
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<Readable> {
    try {
      const chunkDataPromise = this.getChunkData(dataRoot, relativeOffset).then(
        async (cachedChunkData) => {
          // Chunk is cached
          if (cachedChunkData) {
            this.log.info('Successfully fetched chunk data from cache', {
              dataRoot,
              relativeOffset,
            });
            return cachedChunkData;
          }

          // Fetch from ChunkSource
          const chunkData =
            await this.chunkSource.getChunkDataByAbsoluteOrRelativeOffset(
              absoluteOffset,
              dataRoot,
              relativeOffset,
            );

          await this.setChunkData(chunkData, dataRoot, relativeOffset);

          return chunkData;
        },
      );
      const chunkData = await chunkDataPromise;
      return Readable.from(chunkData);
    } catch (error: any) {
      this.log.error('Failed to fetch chunk data:', {
        absoluteOffset,
        dataRoot,
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}

export class FsChunkMetadataCache
  implements ChunkMetadataByAbsoluteOrRelativeOffsetSource
{
  private log: winston.Logger;
  private chunkSource: ChunkByAbsoluteOrRelativeOffsetSource;

  constructor({
    log,
    chunkSource,
  }: {
    log: winston.Logger;
    chunkSource: ChunkByAbsoluteOrRelativeOffsetSource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
  }

  async hasChunkMetadata(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        chunkMetadataCachePath(dataRoot, relativeOffset),
        fs.constants.F_OK,
      );
      return true;
    } catch (error) {
      return false;
    }
  }

  async getChunkMetadata(
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkMetadata | undefined> {
    try {
      if (await this.hasChunkMetadata(dataRoot, relativeOffset)) {
        const msgpack = await fs.promises.readFile(
          chunkMetadataCachePath(dataRoot, relativeOffset),
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

  async setChunkMetadata(chunkMetadata: ChunkMetadata): Promise<void> {
    const { data_root, offset } = chunkMetadata;
    const b64uDataRoot = toB64Url(data_root);
    try {
      await fs.promises.mkdir(chunkMetadataCacheDir(b64uDataRoot), {
        recursive: true,
      });
      const msgpack = toMsgpack(chunkMetadata);
      await fs.promises.writeFile(
        chunkMetadataCachePath(toB64Url(data_root), offset),
        msgpack,
      );
      this.log.info('Successfully cached chunk metadata', {
        dataRoot: b64uDataRoot,
        relativeOffset: offset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk metadata in cache:', {
        dataRoot: b64uDataRoot,
        relativeOffset: offset,
        message: error.message,
        stack: error.stack,
      });
    }
  }

  async getChunkMetadataByAbsoluteOrRelativeOffset(
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkMetadata> {
    try {
      const chunkMetadataPromise = this.getChunkMetadata(
        dataRoot,
        relativeOffset,
      ).then(async (cachedChunkMetadata) => {
        // Chunk metadata is cached
        if (cachedChunkMetadata) {
          this.log.info('Successfully fetched chunk data from cache', {
            dataRoot,
            relativeOffset,
          });
          return cachedChunkMetadata;
        }

        // Fetch from ChunkSource
        const chunk = await this.chunkSource.getChunkByAbsoluteOrRelativeOffset(
          absoluteOffset,
          dataRoot,
          relativeOffset,
        );

        const chunkMetadata = {
          data_root: fromB64Url(dataRoot),
          data_size: chunk.chunk.length,
          offset: relativeOffset,
          data_path: chunk.data_path,
        };

        await this.setChunkMetadata(chunkMetadata);

        return chunkMetadata;
      });

      return await chunkMetadataPromise;
    } catch (error: any) {
      this.log.error('Failed to fetch chunk data:', {
        absoluteOffset,
        dataRoot,
        relativeOffset,
        message: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }
}
