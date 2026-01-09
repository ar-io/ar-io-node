/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Span } from '@opentelemetry/api';
import winston from 'winston';

import { toB64Url } from '../lib/encoding.js';
import { startChildSpan } from '../tracing.js';
import {
  Chunk,
  ChunkByAnySource,
  ChunkDataStore,
  ChunkMetadataStore,
  RequestAttributes,
  TxBoundary,
  TxBoundarySource,
} from '../types.js';

// =============================================================================
// Discriminated Union Result Types
// =============================================================================

/**
 * Common fields shared by all chunk retrieval result types.
 */
interface ChunkRetrievalResultBase {
  /** The retrieved chunk with data, metadata, and proofs */
  chunk: Chunk;
  /** Base64url-encoded data root of the transaction */
  dataRoot: string;
  /** Total size of the transaction data in bytes */
  dataSize: number;
  /** Absolute weave offset of the transaction end (inclusive) */
  weaveOffset: number;
  /** Offset within the transaction data (0-based) */
  relativeOffset: number;
  /** Absolute weave offset where the transaction data starts */
  contiguousDataStartDelimiter: number;
}

/**
 * Result when chunk is retrieved from cache by absoluteOffset lookup.
 * TX ID is not available because it's not stored in the cache metadata.
 */
export interface CacheHitResult extends ChunkRetrievalResultBase {
  type: 'cache_hit';
  // txId intentionally absent - not stored in cache metadata
}

/**
 * Result when chunk is retrieved via TX boundary lookup and chunk fetch.
 * TX ID may be present depending on which boundary source was used:
 * - Database source: has TX ID
 * - tx_path validation: no TX ID (derived from merkle path)
 * - Chain source: has TX ID
 */
export interface BoundaryFetchResult extends ChunkRetrievalResultBase {
  type: 'boundary_fetch';
  /** Transaction ID - present if boundary came from DB or chain lookup */
  txId?: string;
}

/**
 * Discriminated union of all possible chunk retrieval results.
 * Use the `type` field to narrow to specific variants.
 */
export type ChunkRetrievalResult = CacheHitResult | BoundaryFetchResult;

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if result has txId.
 * Only BoundaryFetchResult can have txId, but it's optional.
 */
export function hasTxId(
  result: ChunkRetrievalResult,
): result is BoundaryFetchResult & { txId: string } {
  return result.type === 'boundary_fetch' && result.txId !== undefined;
}

/**
 * Check if result came from cache (fast path).
 */
export function usedCachePath(result: ChunkRetrievalResult): boolean {
  return result.type === 'cache_hit';
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error thrown when a chunk cannot be found via any retrieval path.
 */
export class ChunkNotFoundError extends Error {
  constructor(
    message: string,
    public readonly errorType: string,
  ) {
    super(message);
    this.name = 'ChunkNotFoundError';
  }
}

// =============================================================================
// Service Implementation
// =============================================================================

export interface ChunkRetrievalServiceConfig {
  log: winston.Logger;
  chunkSource: ChunkByAnySource;
  txBoundarySource: TxBoundarySource;
  // Optional cache stores for fast path
  chunkDataStore?: ChunkDataStore;
  chunkMetadataStore?: ChunkMetadataStore;
}

/**
 * Service that encapsulates the complete chunk retrieval pipeline:
 * 1. Fast path: Cache lookup by absoluteOffset
 * 2. TX boundary lookup via composite source (DB → tx_path → chain)
 * 3. Chunk fetch using TX boundary info
 *
 * Returns discriminated union results that encode which path was used
 * and what data is available.
 */
export class ChunkRetrievalService {
  private log: winston.Logger;
  private chunkSource: ChunkByAnySource;
  private txBoundarySource: TxBoundarySource;
  // Optional cache stores for fast path
  private chunkDataStore?: ChunkDataStore;
  private chunkMetadataStore?: ChunkMetadataStore;

  constructor(config: ChunkRetrievalServiceConfig) {
    this.log = config.log.child({ class: this.constructor.name });
    this.chunkSource = config.chunkSource;
    this.txBoundarySource = config.txBoundarySource;
    this.chunkDataStore = config.chunkDataStore;
    this.chunkMetadataStore = config.chunkMetadataStore;
  }

  /**
   * Retrieves a chunk by absolute weave offset.
   *
   * Tries cache first, then uses TX boundary source to find the transaction
   * and fetch the chunk.
   *
   * @param absoluteOffset - The absolute byte offset in the weave
   * @param requestAttributes - Optional request attributes for hop tracking
   * @param parentSpan - Optional parent span for tracing
   * @param signal - Optional abort signal to cancel the request
   * @returns Discriminated union result indicating which path was used
   * @throws ChunkNotFoundError if chunk cannot be retrieved
   */
  async retrieveChunk(
    absoluteOffset: number,
    requestAttributes?: RequestAttributes,
    parentSpan?: Span,
    signal?: AbortSignal,
  ): Promise<ChunkRetrievalResult> {
    const span = startChildSpan(
      'ChunkRetrievalService.retrieveChunk',
      {
        attributes: {
          'chunk.absolute_offset': absoluteOffset,
        },
      },
      parentSpan,
    );

    try {
      // Check for abort before starting
      signal?.throwIfAborted();

      // 1. Try cache hit first
      if (this.chunkDataStore && this.chunkMetadataStore) {
        const cacheResult = await this.tryCacheHit(absoluteOffset, span);
        if (cacheResult) {
          span.setAttribute('chunk.retrieval_path', 'cache_hit');
          return cacheResult;
        }
      }

      // Check for abort before TX boundary lookup
      signal?.throwIfAborted();

      // 2. Get TX boundary from composite source (handles DB → tx_path → chain)
      span.addEvent('Getting TX boundary');
      const txBoundary = await this.txBoundarySource.getTxBoundary(
        BigInt(absoluteOffset),
        signal,
      );

      if (!txBoundary) {
        throw new ChunkNotFoundError(
          `No TX boundary found for offset ${absoluteOffset}`,
          'boundary_not_found',
        );
      }

      span.addEvent('TX boundary found', {
        tx_id: txBoundary.id ?? 'unknown',
        data_root: txBoundary.dataRoot,
        data_size: txBoundary.dataSize,
      });

      // 3. Fetch chunk using TX boundary
      span.setAttribute('chunk.retrieval_path', 'boundary_fetch');
      return await this.fetchChunkWithBoundary(
        absoluteOffset,
        txBoundary,
        requestAttributes,
        span,
        signal,
      );
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

  /**
   * Attempts to retrieve chunk from cache by absoluteOffset.
   * Returns null if cache miss.
   */
  private async tryCacheHit(
    absoluteOffset: number,
    parentSpan: Span,
  ): Promise<CacheHitResult | null> {
    const span = startChildSpan(
      'ChunkRetrievalService.tryCacheHit',
      { attributes: { 'chunk.absolute_offset': absoluteOffset } },
      parentSpan,
    );

    try {
      span.addEvent('Checking cache by absoluteOffset');
      const cacheCheckStart = Date.now();

      // Parallel lookup in both caches
      const [cachedChunkData, cachedChunkMetadata] = await Promise.all([
        this.chunkDataStore!.getByAbsoluteOffset(absoluteOffset),
        this.chunkMetadataStore!.getByAbsoluteOffset(absoluteOffset),
      ]);

      const cacheCheckDuration = Date.now() - cacheCheckStart;
      span.setAttribute('chunk.cache_check_duration_ms', cacheCheckDuration);

      if (cachedChunkData && cachedChunkMetadata) {
        span.addEvent('Cache hit', {
          cache_check_duration_ms: cacheCheckDuration,
        });

        // Derive TX boundaries from cached metadata
        const relativeOffset = cachedChunkMetadata.offset;
        const dataSize = cachedChunkMetadata.data_size;
        const dataRoot = toB64Url(cachedChunkMetadata.data_root);

        // Calculate weave offsets from absoluteOffset and relativeOffset
        const contiguousDataStartDelimiter = absoluteOffset - relativeOffset;
        const weaveOffset = contiguousDataStartDelimiter + dataSize - 1;

        // Construct Chunk from cached data + metadata
        const chunk: Chunk = {
          ...cachedChunkData,
          ...cachedChunkMetadata,
          source: 'cache',
          sourceHost: undefined,
        };

        this.log.debug('Fast path cache hit', {
          absoluteOffset,
          dataRoot,
          relativeOffset,
        });

        return {
          type: 'cache_hit',
          chunk,
          dataRoot,
          dataSize,
          weaveOffset,
          relativeOffset,
          contiguousDataStartDelimiter,
        };
      }

      span.addEvent('Cache miss', {
        cache_check_duration_ms: cacheCheckDuration,
      });
      return null;
    } catch (error: any) {
      span.recordException(error);
      this.log.debug('Cache lookup failed', {
        absoluteOffset,
        error: error.message,
      });
      return null;
    } finally {
      span.end();
    }
  }

  /**
   * Fetches chunk using TX boundary info.
   * Always returns a result or throws ChunkNotFoundError.
   */
  private async fetchChunkWithBoundary(
    absoluteOffset: number,
    txBoundary: TxBoundary,
    requestAttributes: RequestAttributes | undefined,
    parentSpan: Span,
    signal?: AbortSignal,
  ): Promise<BoundaryFetchResult> {
    const span = startChildSpan(
      'ChunkRetrievalService.fetchChunkWithBoundary',
      { attributes: { 'chunk.absolute_offset': absoluteOffset } },
      parentSpan,
    );

    try {
      // Check for abort before starting
      signal?.throwIfAborted();

      const { dataRoot, dataSize, weaveOffset, id: txId } = txBoundary;

      // Calculate the relative offset
      // weaveOffset is the end offset; data starts at (weaveOffset - dataSize + 1)
      const contiguousDataStartDelimiter = weaveOffset - dataSize + 1;
      const relativeOffset = absoluteOffset - contiguousDataStartDelimiter;

      span.setAttributes({
        'chunk.tx_id': txId ?? 'unknown',
        'chunk.data_root': dataRoot,
        'chunk.data_size': dataSize,
        'chunk.weave_offset': weaveOffset,
        'chunk.relative_offset': relativeOffset,
      });

      // Fetch the chunk data
      span.addEvent('Starting chunk retrieval');
      const chunkRetrievalStart = Date.now();

      let chunk: Chunk;
      try {
        chunk = await this.chunkSource.getChunkByAny(
          {
            txSize: dataSize,
            absoluteOffset,
            dataRoot,
            relativeOffset,
            requestAttributes,
          },
          signal,
        );
      } catch (error: any) {
        const retrievalDuration = Date.now() - chunkRetrievalStart;
        span.setAttribute('chunk.retrieval.duration_ms', retrievalDuration);
        // Re-throw AbortError without wrapping
        if (error.name === 'AbortError') {
          throw error;
        }
        throw new ChunkNotFoundError(
          `Chunk fetch failed: ${error.message}`,
          'fetch_failed',
        );
      }

      const retrievalDuration = Date.now() - chunkRetrievalStart;
      span.setAttribute('chunk.retrieval.duration_ms', retrievalDuration);
      span.addEvent('Chunk retrieval successful', {
        duration_ms: retrievalDuration,
        source: chunk.source,
      });

      return {
        type: 'boundary_fetch',
        chunk,
        txId,
        dataRoot,
        dataSize,
        weaveOffset,
        relativeOffset,
        contiguousDataStartDelimiter,
      };
    } catch (error: any) {
      if (
        !(error instanceof ChunkNotFoundError) &&
        error.name !== 'AbortError'
      ) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }
}
