/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  ChunkDataStore,
} from '../types.js';

export class ReadThroughChunkDataCache implements ChunkDataByAnySource {
  private log: winston.Logger;
  private chunkSource: ChunkDataByAnySource;
  private chunkStore: ChunkDataStore;

  constructor({
    log,
    chunkSource,
    chunkDataStore,
  }: {
    log: winston.Logger;
    chunkSource: ChunkDataByAnySource;
    chunkDataStore: ChunkDataStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
    this.chunkStore = chunkDataStore;
  }

  async getChunkDataByAny({
    txSize,
    absoluteOffset,
    dataRoot,
    relativeOffset,
  }: ChunkDataByAnySourceParams): Promise<ChunkData> {
    const chunkDataPromise = this.chunkStore
      .get(dataRoot, relativeOffset)
      .then(async (cachedChunkData) => {
        // Chunk is cached
        if (cachedChunkData) {
          this.log.debug('Successfully fetched chunk data from cache', {
            dataRoot,
            relativeOffset,
          });
          return cachedChunkData;
        }

        // Fetch from ChunkSource
        const chunkData = await this.chunkSource.getChunkDataByAny({
          txSize,
          absoluteOffset,
          dataRoot,
          relativeOffset,
        });

        await this.chunkStore.set(dataRoot, relativeOffset, chunkData);

        return chunkData;
      });

    return chunkDataPromise;
  }
}
