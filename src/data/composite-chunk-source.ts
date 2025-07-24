/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  ChunkMetadataByAnySource,
  ChunkByAnySource,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  Chunk,
  ChunkData,
  ChunkMetadata,
} from '../types';

export class CompositeChunkSource
  implements ChunkByAnySource, ChunkMetadataByAnySource, ChunkDataByAnySource
{
  private readonly chunkMetadataSource: ChunkMetadataByAnySource;
  private readonly chunkDataSource: ChunkDataByAnySource;

  constructor(
    chunkMetadataSource: ChunkMetadataByAnySource,
    chunkDataSource: ChunkDataByAnySource,
  ) {
    this.chunkMetadataSource = chunkMetadataSource;
    this.chunkDataSource = chunkDataSource;
  }

  async getChunkByAny(params: ChunkDataByAnySourceParams): Promise<Chunk> {
    const metadata =
      await this.chunkMetadataSource.getChunkMetadataByAny(params);

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

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    return this.chunkDataSource.getChunkDataByAny(params);
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkMetadata> {
    return this.chunkMetadataSource.getChunkMetadataByAny(params);
  }
}
