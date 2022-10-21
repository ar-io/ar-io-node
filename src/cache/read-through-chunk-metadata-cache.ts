import winston from 'winston';

import {
  ChunkByAbsoluteOrRelativeOffsetSource,
  ChunkMetadata,
  ChunkMetadataByAbsoluteOrRelativeOffsetSource,
  ChunkMetadataStore,
} from '../types.js';

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
    txSize: number,
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
              txSize,
              absoluteOffset,
              dataRoot,
              relativeOffset,
            );

          // TODO extract chunk data sha256 from data_path

          const chunkMetadata = {
            data_root: chunk.tx_path.slice(-64, -32),
            data_size: chunk.chunk.length,
            offset: relativeOffset,
            data_path: chunk.data_path,
            sha256: chunk.data_path.slice(-64, -32),
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
