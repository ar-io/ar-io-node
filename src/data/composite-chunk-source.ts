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

import {
  ChunkMetadataByAnySource,
  ChunkByAnySource,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  Chunk,
} from '../types';

export class CompositeChunkSource implements ChunkByAnySource {
  private readonly chunkMetaDataSource: ChunkMetadataByAnySource;
  private readonly chunkDataSource: ChunkDataByAnySource;

  constructor(
    chunkMetaDataSource: ChunkMetadataByAnySource,
    chunkDataSource: ChunkDataByAnySource,
  ) {
    this.chunkMetaDataSource = chunkMetaDataSource;
    this.chunkDataSource = chunkDataSource;
  }

  async getChunkByAny(params: ChunkDataByAnySourceParams): Promise<Chunk> {
    const metadata =
      await this.chunkMetaDataSource.getChunkMetadataByAny(params);

    const chunkDataParams: ChunkDataByAnySourceParams = {
      txSize: params.txSize,
      absoluteOffset: params.absoluteOffset,
      dataRoot: params.dataRoot,
      relativeOffset: metadata.offset, // aligned offset
    };

    const data = await this.chunkDataSource.getChunkDataByAny(chunkDataParams);

    return {
      ...metadata,
      ...data,
      tx_path: undefined,
    };
  }
}
