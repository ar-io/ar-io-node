/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import { tracer } from '../tracing.js';
import { isValidationParams } from '../lib/validation.js';

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

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    // This source only supports validation params (txSize, dataRoot, relativeOffset)
    if (!isValidationParams(params)) {
      throw new Error(
        'ReadThroughChunkDataCache requires validation params (txSize, dataRoot, relativeOffset)',
      );
    }

    const { txSize, absoluteOffset, dataRoot, relativeOffset } = params;

    const span = tracer.startSpan(
      'ReadThroughChunkDataCache.getChunkDataByAny',
      {
        attributes: {
          'chunk.data_root': dataRoot,
          'chunk.absolute_offset': absoluteOffset,
          'chunk.relative_offset': relativeOffset,
          'chunk.tx_size': txSize,
        },
      },
    );

    try {
      span.addEvent('Checking cache');
      const cacheCheckStart = Date.now();

      const cachedChunkData = await this.chunkStore.get(
        dataRoot,
        relativeOffset,
      );
      const cacheCheckDuration = Date.now() - cacheCheckStart;

      // Chunk is cached
      if (cachedChunkData) {
        span.setAttributes({
          'chunk.cache_hit': true,
          'chunk.cache_check_duration_ms': cacheCheckDuration,
          'chunk.source': 'cache',
        });

        span.addEvent('Cache hit', {
          cache_check_duration_ms: cacheCheckDuration,
        });

        this.log.debug('Successfully fetched chunk data from cache', {
          dataRoot,
          relativeOffset,
        });

        return {
          ...cachedChunkData,
          source: 'cache',
          // No sourceHost for cache hits
          sourceHost: undefined,
        };
      }

      // Cache miss - need to fetch from source
      span.setAttributes({
        'chunk.cache_hit': false,
        'chunk.cache_check_duration_ms': cacheCheckDuration,
      });

      span.addEvent('Cache miss - fetching from source', {
        cache_check_duration_ms: cacheCheckDuration,
      });

      const sourceStart = Date.now();
      const chunkData = await this.chunkSource.getChunkDataByAny({
        txSize,
        absoluteOffset,
        dataRoot,
        relativeOffset,
      });
      const sourceDuration = Date.now() - sourceStart;

      span.setAttributes({
        'chunk.source_fetch_duration_ms': sourceDuration,
        'chunk.source': chunkData.source ?? 'unknown',
        'chunk.source_host': chunkData.sourceHost ?? 'unknown',
      });

      span.addEvent('Source fetch completed', {
        source_duration_ms: sourceDuration,
        chunk_source: chunkData.source,
      });

      // Cache the result (with absoluteOffset for symlink index)
      const cacheStoreStart = Date.now();
      await this.chunkStore.set(
        dataRoot,
        relativeOffset,
        chunkData,
        absoluteOffset,
      );
      const cacheStoreDuration = Date.now() - cacheStoreStart;

      span.setAttributes({
        'chunk.cache_store_duration_ms': cacheStoreDuration,
      });

      span.addEvent('Chunk cached', {
        cache_store_duration_ms: cacheStoreDuration,
      });

      return chunkData;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
