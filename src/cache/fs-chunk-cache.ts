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
  ChunkDataStore,
  ChunkMetadata,
  ChunkMetadataByAbsoluteOrRelativeOffsetSource,
  ChunkMetadataStore,
} from '../types.js';

export class FsChunkDataStore implements ChunkDataStore {
  private log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: this.constructor.name });
  }

  private chunkDataCacheDir(dataRoot: string) {
    return `data/chunks/${dataRoot}/data/`;
  }

  private chunkDataCachePath(dataRoot: string, relativeOffset: number) {
    return `${this.chunkDataCacheDir(dataRoot)}/${relativeOffset}`;
  }

  async has(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        this.chunkDataCachePath(dataRoot, relativeOffset),
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
          this.chunkDataCachePath(dataRoot, relativeOffset),
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
    data: Readable,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<void> {
    try {
      await fs.promises.mkdir(this.chunkDataCacheDir(dataRoot), {
        recursive: true,
      });
      await fs.promises.writeFile(
        this.chunkDataCachePath(dataRoot, relativeOffset),
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

export class FsChunkStore implements ChunkDataByAbsoluteOrRelativeOffsetSource {
  private log: winston.Logger;
  private chunkSource: ChunkDataByAbsoluteOrRelativeOffsetSource;
  private chunkStore: ChunkDataStore;

  constructor({
    log,
    chunkSource,
    chunkDataStore,
  }: {
    log: winston.Logger;
    chunkSource: ChunkDataByAbsoluteOrRelativeOffsetSource;
    chunkDataStore: ChunkDataStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
    this.chunkStore = chunkDataStore;
  }

  async getChunkDataByAbsoluteOrRelativeOffset(
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<Readable> {
    try {
      const chunkDataPromise = this.chunkStore
        .get(dataRoot, relativeOffset)
        .then(async (cachedChunkData) => {
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

          await this.chunkStore.set(chunkData, dataRoot, relativeOffset);

          return chunkData;
        });
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

export class FsChunkMetadataStore implements ChunkMetadataStore {
  private log: winston.Logger;

  constructor({ log }: { log: winston.Logger }) {
    this.log = log.child({ class: this.constructor.name });
  }

  private chunkMetadataCacheDir(dataRoot: string) {
    return `data/chunks/${dataRoot}/metadata/`;
  }

  private chunkMetadataCachePath(dataRoot: string, relativeOffset: number) {
    return `${this.chunkMetadataCacheDir(dataRoot)}/${relativeOffset}`;
  }

  async has(dataRoot: string, relativeOffset: number) {
    try {
      await fs.promises.access(
        this.chunkMetadataCachePath(dataRoot, relativeOffset),
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
          this.chunkMetadataCachePath(dataRoot, relativeOffset),
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

  async set(chunkMetadata: ChunkMetadata): Promise<void> {
    const { data_root, offset } = chunkMetadata;
    const dataRoot = toB64Url(data_root);
    try {
      await fs.promises.mkdir(this.chunkMetadataCacheDir(dataRoot), {
        recursive: true,
      });
      const msgpack = toMsgpack(chunkMetadata);
      await fs.promises.writeFile(
        this.chunkMetadataCachePath(toB64Url(data_root), offset),
        msgpack,
      );
      this.log.info('Successfully cached chunk metadata', {
        dataRoot,
        relativeOffset: offset,
      });
    } catch (error: any) {
      this.log.error('Failed to set chunk metadata in cache:', {
        dataRoot,
        relativeOffset: offset,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}

export class FsChunkMetadataCache
  implements ChunkMetadataByAbsoluteOrRelativeOffsetSource
{
  private log: winston.Logger;
  private chunkSource: ChunkByAbsoluteOrRelativeOffsetSource;
  private chunkMetadataStore: ChunkMetadataStore;

  constructor({
    log,
    chunkSource,
    chunkMetadataStore,
  }: {
    log: winston.Logger;
    chunkSource: ChunkByAbsoluteOrRelativeOffsetSource;
    chunkMetadataStore: ChunkMetadataStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
    this.chunkMetadataStore = chunkMetadataStore;
  }

  async getChunkMetadataByAbsoluteOrRelativeOffset(
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkMetadata> {
    try {
      const chunkMetadataPromise = this.chunkMetadataStore
        .get(dataRoot, relativeOffset)
        .then(async (cachedChunkMetadata) => {
          // Chunk metadata is cached
          if (cachedChunkMetadata) {
            this.log.info('Successfully fetched chunk data from cache', {
              dataRoot,
              relativeOffset,
            });
            return cachedChunkMetadata;
          }

          // Fetch from ChunkSource
          const chunk =
            await this.chunkSource.getChunkByAbsoluteOrRelativeOffset(
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

          await this.chunkMetadataStore.set(chunkMetadata);

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
