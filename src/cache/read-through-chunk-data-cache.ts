import { Readable } from 'stream';
import winston from 'winston';

import {
  ChunkDataByAbsoluteOrRelativeOffsetSource,
  ChunkDataStore,
} from '../types.js';

export class ReadThroughChunkDataCache
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
