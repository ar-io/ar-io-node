/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { tracer } from '../tracing.js';
import { isValidationParams } from '../lib/validation.js';
import {
  ChunkMetadataByAnySource,
  ChunkByAnySource,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  ChunkWithValidationParams,
  Chunk,
  ChunkData,
  ChunkMetadata,
} from '../types.js';

export class FullChunkSource
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

  async getChunkByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<Chunk> {
    // Check for abort before starting
    signal?.throwIfAborted();

    // This source only supports validation params (txSize, dataRoot, relativeOffset)
    if (!isValidationParams(params)) {
      throw new Error(
        'FullChunkSource requires validation params (txSize, dataRoot, relativeOffset)',
      );
    }

    const span = tracer.startSpan('FullChunkSource.getChunkByAny', {
      attributes: {
        'chunk.data_root': params.dataRoot,
        'chunk.absolute_offset': params.absoluteOffset,
        'chunk.relative_offset': params.relativeOffset,
        'chunk.tx_size': params.txSize,
      },
    });

    try {
      span.addEvent('Fetching chunk metadata');
      const metadataStart = Date.now();

      const metadata = await this.chunkMetadataSource.getChunkMetadataByAny(
        params,
        signal,
      );
      const metadataDuration = Date.now() - metadataStart;

      span.setAttributes({
        'chunk.metadata_duration_ms': metadataDuration,
        'chunk.metadata_offset': metadata.offset,
        'chunk.metadata_size': metadata.chunk_size,
      });

      span.addEvent('Metadata retrieved', {
        duration_ms: metadataDuration,
        aligned_offset: metadata.offset,
        chunk_size: metadata.chunk_size,
      });

      // Check for abort before fetching data
      signal?.throwIfAborted();

      const chunkDataParams: ChunkWithValidationParams = {
        txSize: params.txSize,
        absoluteOffset: params.absoluteOffset,
        dataRoot: params.dataRoot,
        relativeOffset: metadata.offset, // aligned offset
      };

      span.addEvent('Fetching chunk data');
      const dataStart = Date.now();

      const data = await this.chunkDataSource.getChunkDataByAny(
        chunkDataParams,
        signal,
      );
      const dataDuration = Date.now() - dataStart;

      span.setAttributes({
        'chunk.data_duration_ms': dataDuration,
        'chunk.source': data.source ?? 'unknown',
        'chunk.source_host': data.sourceHost ?? 'unknown',
      });

      span.addEvent('Chunk data retrieved', {
        duration_ms: dataDuration,
        chunk_source: data.source,
        chunk_host: data.sourceHost,
      });

      const result = {
        ...metadata,
        ...data,
        tx_path: metadata.tx_path ?? undefined,
      };

      span.addEvent('Full chunk assembly complete');
      return result;
    } catch (error: any) {
      // Don't record AbortError as an exception
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkData> {
    return this.chunkDataSource.getChunkDataByAny(params, signal);
  }

  async getChunkMetadataByAny(
    params: ChunkDataByAnySourceParams,
    signal?: AbortSignal,
  ): Promise<ChunkMetadata> {
    return this.chunkMetadataSource.getChunkMetadataByAny(params, signal);
  }
}
