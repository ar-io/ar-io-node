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
