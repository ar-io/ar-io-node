/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import winston from 'winston';

import { ChunkData, ChunkDataByAnySource, ChunkDataStore } from '../types.js';

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

  async getChunkDataByAny(
    txSize: number,
    absoluteOffset: number,
    dataRoot: string,
    relativeOffset: number,
  ): Promise<ChunkData> {
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
        const chunkData = await this.chunkSource.getChunkDataByAny(
          txSize,
          absoluteOffset,
          dataRoot,
          relativeOffset,
        );

        await this.chunkStore.set(dataRoot, relativeOffset, chunkData);

        return chunkData;
      });

    return chunkDataPromise;
  }
}
