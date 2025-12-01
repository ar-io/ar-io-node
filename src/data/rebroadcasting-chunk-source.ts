/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import pLimit from 'p-limit';
import { LRUCache } from 'lru-cache';
import { TokenBucket } from 'limiter';
import { context, trace, Span } from '@opentelemetry/api';

import { tracer } from '../tracing.js';
import { toB64Url } from '../lib/encoding.js';
import { headerNames } from '../constants.js';
import * as config from '../config.js';
import * as metrics from '../metrics.js';
import {
  Chunk,
  ChunkByAnySource,
  ChunkBroadcaster,
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
  JsonChunkPost,
} from '../types.js';

const DEDUP_CACHE_MAX_SIZE = 10000;

export interface RebroadcastOptions {
  sources: string[];
  rateLimitTokens: number;
  rateLimitInterval: 'second' | 'minute' | 'hour' | 'day';
  maxConcurrent: number;
  dedupTtlSeconds: number;
  minSuccessCount: number;
}

/**
 * A wrapper for ChunkByAnySource that asynchronously rebroadcasts chunks
 * from configured sources to the Arweave network.
 *
 * This wrapper is fire-and-forget - rebroadcasting happens asynchronously
 * and never blocks the chunk fetch operation.
 */
export class RebroadcastingChunkSource
  implements ChunkByAnySource, ChunkDataByAnySource
{
  private log: winston.Logger;
  private chunkSource: ChunkByAnySource & ChunkDataByAnySource;
  private chunkBroadcaster: ChunkBroadcaster;
  private options: RebroadcastOptions;
  private recentlyRebroadcasted: LRUCache<string, boolean>;
  private concurrencyLimit: ReturnType<typeof pLimit>;
  private rateLimiter: TokenBucket;
  private pendingRebroadcasts: Set<Promise<void>> = new Set();

  constructor({
    log,
    chunkSource,
    chunkBroadcaster,
    options,
  }: {
    log: winston.Logger;
    chunkSource: ChunkByAnySource & ChunkDataByAnySource;
    chunkBroadcaster: ChunkBroadcaster;
    options: RebroadcastOptions;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chunkSource = chunkSource;
    this.chunkBroadcaster = chunkBroadcaster;
    this.options = options;

    this.recentlyRebroadcasted = new LRUCache({
      max: DEDUP_CACHE_MAX_SIZE,
      ttl: options.dedupTtlSeconds * 1000,
    });

    this.concurrencyLimit = pLimit(options.maxConcurrent);

    this.rateLimiter = new TokenBucket({
      bucketSize: options.rateLimitTokens,
      tokensPerInterval: options.rateLimitTokens,
      interval: options.rateLimitInterval,
    });
    // Pre-fill the bucket so tokens are available immediately
    this.rateLimiter.content = this.rateLimiter.bucketSize;

    this.log.info('RebroadcastingChunkSource initialized', {
      sources: options.sources,
      rateLimitTokens: options.rateLimitTokens,
      rateLimitInterval: options.rateLimitInterval,
      maxConcurrent: options.maxConcurrent,
      dedupTtlSeconds: options.dedupTtlSeconds,
      minSuccessCount: options.minSuccessCount,
    });
  }

  async getChunkByAny(params: ChunkDataByAnySourceParams): Promise<Chunk> {
    // 1. Delegate to wrapped source
    const chunk = await this.chunkSource.getChunkByAny(params);

    // 2. Fire-and-forget rebroadcast (non-blocking)
    const rebroadcastPromise = this.maybeRebroadcast(chunk, params)
      .catch((error) => {
        this.log.warn('Rebroadcast error (non-blocking)', {
          error: error.message,
          dataRoot: params.dataRoot,
          relativeOffset: params.relativeOffset,
        });
      })
      .finally(() => {
        this.pendingRebroadcasts.delete(rebroadcastPromise);
      });
    this.pendingRebroadcasts.add(rebroadcastPromise);

    // 3. Return immediately
    return chunk;
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    return this.chunkSource.getChunkDataByAny(params);
  }

  /**
   * Awaits all pending rebroadcast operations. Useful for testing.
   */
  async awaitPendingRebroadcasts(): Promise<void> {
    await Promise.all(this.pendingRebroadcasts);
  }

  private async maybeRebroadcast(
    chunk: Chunk,
    params: ChunkDataByAnySourceParams,
  ): Promise<void> {
    const span = tracer.startSpan(
      'RebroadcastingChunkSource.maybeRebroadcast',
      {
        attributes: {
          'chunk.data_root': params.dataRoot,
          'chunk.relative_offset': params.relativeOffset,
          'chunk.source': chunk.source ?? 'unknown',
        },
      },
    );

    try {
      // Skip if source is 'cache' (hardcoded exclusion)
      if (chunk.source === 'cache') {
        span.setAttribute('chunk.rebroadcast.skipped', 'cache_source');
        metrics.chunkRebroadcastSkippedTotal.inc({ reason: 'cache_source' });
        return;
      }

      // Skip if source not in configured sources
      if (
        chunk.source === undefined ||
        !this.options.sources.includes(chunk.source)
      ) {
        span.setAttribute('chunk.rebroadcast.skipped', 'source_not_configured');
        metrics.chunkRebroadcastSkippedTotal.inc({
          reason: 'source_not_configured',
        });
        return;
      }

      // Check deduplication cache
      const cacheKey = `${params.dataRoot}:${params.relativeOffset}`;
      if (this.recentlyRebroadcasted.has(cacheKey)) {
        span.setAttribute('chunk.rebroadcast.skipped', 'dedup_cache_hit');
        metrics.chunkRebroadcastSkippedTotal.inc({ reason: 'dedup_cache_hit' });
        return;
      }

      // Check rate limit
      if (!this.rateLimiter.tryRemoveTokens(1)) {
        span.setAttribute('chunk.rebroadcast.skipped', 'rate_limited');
        metrics.chunkRebroadcastSkippedTotal.inc({ reason: 'rate_limited' });
        this.log.debug('Chunk rebroadcast rate limited', { cacheKey });
        return;
      }

      // Broadcast with concurrency limit
      await this.concurrencyLimit(async () => {
        await this.broadcast(chunk, params, span);
      });

      span.setAttribute('chunk.rebroadcast.completed', true);
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async broadcast(
    chunk: Chunk,
    params: ChunkDataByAnySourceParams,
    parentSpan: Span,
  ): Promise<void> {
    const span = tracer.startSpan(
      'RebroadcastingChunkSource.broadcast',
      {},
      trace.setSpan(context.active(), parentSpan),
    );

    try {
      metrics.chunkRebroadcastAttemptsTotal.inc();

      const jsonChunk = this.chunkToJsonChunkPost(chunk);

      const originAndHopsHeaders: Record<string, string | undefined> = {
        [headerNames.originNodeRelease]: config.AR_IO_NODE_RELEASE,
      };

      const result = await this.chunkBroadcaster.broadcastChunk({
        chunk: jsonChunk,
        originAndHopsHeaders,
        chunkPostMinSuccessCount: this.options.minSuccessCount,
        parentSpan: span,
      });

      span.setAttributes({
        'chunk.broadcast.success_count': result.successCount,
        'chunk.broadcast.failure_count': result.failureCount,
      });

      // Only add to dedup cache on full success
      if (result.successCount >= this.options.minSuccessCount) {
        const cacheKey = `${params.dataRoot}:${params.relativeOffset}`;
        this.recentlyRebroadcasted.set(cacheKey, true);
        span.setAttribute('chunk.rebroadcast.cached', true);
        metrics.chunkRebroadcastSuccessesTotal.inc();
      } else {
        metrics.chunkRebroadcastFailuresTotal.inc();
        this.log.warn('Chunk rebroadcast did not meet success threshold', {
          dataRoot: params.dataRoot,
          relativeOffset: params.relativeOffset,
          successCount: result.successCount,
          minSuccessCount: this.options.minSuccessCount,
        });
      }
    } catch (error: any) {
      span.recordException(error);
      metrics.chunkRebroadcastFailuresTotal.inc();
      throw error;
    } finally {
      span.end();
    }
  }

  private chunkToJsonChunkPost(chunk: Chunk): JsonChunkPost {
    return {
      data_root: toB64Url(chunk.data_root),
      chunk: toB64Url(chunk.chunk),
      data_size: chunk.data_size.toString(),
      data_path: toB64Url(chunk.data_path),
      offset: chunk.offset.toString(),
    };
  }
}
