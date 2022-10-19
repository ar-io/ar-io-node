import { Readable } from 'stream';
import winston from 'winston';

import { fromB64Url } from '../lib/encoding.js';
import {
  ChunkByAbsoluteOrRelativeOffsetSource,
  ChunkDataByAbsoluteOrRelativeOffsetSource,
  ChunkDataStore,
  ChunkMetadata,
  ChunkMetadataByAbsoluteOrRelativeOffsetSource,
  ChunkMetadataStore,
} from '../types.js';

export class ReadThroughChunkCache
  implements ChunkDataByAbsoluteOrRelativeOffsetSource
{
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

export class ReadThroughChunkMetadataCache
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
