/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Span } from '@opentelemetry/api';
import winston from 'winston';

import { ArweaveCompositeClient } from '../arweave/composite-client.js';
import { fromB64Url, toB64Url } from '../lib/encoding.js';
import { parseTxPath, safeBigIntToNumber } from '../lib/tx-path-parser.js';
import { validateChunk } from '../lib/validation.js';
import { startChildSpan } from '../tracing.js';
import {
  Chunk,
  ChunkByAnySource,
  ChunkDataStore,
  ChunkMetadataStore,
  RequestAttributes,
  TxOffsetSource,
  UnvalidatedChunkSource,
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
 * Result when chunk is validated via tx_path against block's tx_root.
 * TX ID is not available because we derived TX boundaries from the merkle path,
 * not from a TX lookup.
 */
export interface TxPathValidatedResult extends ChunkRetrievalResultBase {
  type: 'tx_path_validated';
  // txId intentionally absent - derived from tx_path, not TX lookup
}

/**
 * Result when chunk is retrieved via the traditional fallback path using
 * txOffsetSource to look up TX info first.
 * TX ID is always present because it comes from the txOffsetSource lookup.
 */
export interface FallbackResult extends ChunkRetrievalResultBase {
  type: 'fallback';
  /** Transaction ID - always present from txOffsetSource lookup */
  txId: string;
}

/**
 * Discriminated union of all possible chunk retrieval results.
 * Use the `type` field to narrow to specific variants.
 */
export type ChunkRetrievalResult =
  | CacheHitResult
  | TxPathValidatedResult
  | FallbackResult;

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard to check if result has txId (only FallbackResult).
 */
export function hasTxId(
  result: ChunkRetrievalResult,
): result is FallbackResult {
  return result.type === 'fallback';
}

/**
 * Check if result came from the fast path (cache hit or tx_path validation).
 */
export function usedFastPath(result: ChunkRetrievalResult): boolean {
  return result.type === 'cache_hit' || result.type === 'tx_path_validated';
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
  txOffsetSource: TxOffsetSource;
  // Optional fast path dependencies
  chunkDataStore?: ChunkDataStore;
  chunkMetadataStore?: ChunkMetadataStore;
  arweaveClient?: ArweaveCompositeClient;
  unvalidatedChunkSource?: UnvalidatedChunkSource;
}

/**
 * Service that encapsulates the complete chunk retrieval pipeline:
 * 1. Fast path: Cache lookup by absoluteOffset
 * 2. Fast path: tx_path validation against block's tx_root
 * 3. Fallback: Traditional txOffsetSource + chunkSource flow
 *
 * Returns discriminated union results that encode which path was used
 * and what data is available.
 */
export class ChunkRetrievalService {
  private log: winston.Logger;
  private chunkSource: ChunkByAnySource;
  private txOffsetSource: TxOffsetSource;
  // Optional fast path dependencies
  private chunkDataStore?: ChunkDataStore;
  private chunkMetadataStore?: ChunkMetadataStore;
  private arweaveClient?: ArweaveCompositeClient;
  private unvalidatedChunkSource?: UnvalidatedChunkSource;

  constructor(config: ChunkRetrievalServiceConfig) {
    this.log = config.log.child({ class: this.constructor.name });
    this.chunkSource = config.chunkSource;
    this.txOffsetSource = config.txOffsetSource;
    this.chunkDataStore = config.chunkDataStore;
    this.chunkMetadataStore = config.chunkMetadataStore;
    this.arweaveClient = config.arweaveClient;
    this.unvalidatedChunkSource = config.unvalidatedChunkSource;
  }

  /**
   * Retrieves a chunk by absolute weave offset.
   *
   * Tries the fast path first (cache lookup, then tx_path validation),
   * falling back to the traditional txOffsetSource flow if needed.
   *
   * @param absoluteOffset - The absolute byte offset in the weave
   * @param requestAttributes - Optional request attributes for hop tracking
   * @param parentSpan - Optional parent span for tracing
   * @returns Discriminated union result indicating which path was used
   * @throws ChunkNotFoundError if chunk cannot be retrieved
   */
  async retrieveChunk(
    absoluteOffset: number,
    requestAttributes?: RequestAttributes,
    parentSpan?: Span,
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
      // Try fast path first if dependencies are available
      if (this.chunkDataStore && this.chunkMetadataStore) {
        // Try cache hit
        const cacheResult = await this.tryCacheHit(absoluteOffset, span);
        if (cacheResult) {
          span.setAttribute('chunk.retrieval_path', 'cache_hit');
          return cacheResult;
        }

        // Try tx_path validation
        if (this.unvalidatedChunkSource && this.arweaveClient) {
          const txPathResult = await this.tryTxPathValidation(
            absoluteOffset,
            requestAttributes,
            span,
          );
          if (txPathResult) {
            span.setAttribute('chunk.retrieval_path', 'tx_path_validated');
            return txPathResult;
          }
        }
      }

      // Fallback to traditional path
      span.setAttribute('chunk.retrieval_path', 'fallback');
      return await this.fallbackPath(absoluteOffset, requestAttributes, span);
    } catch (error: any) {
      span.recordException(error);
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
   * Attempts to validate chunk via tx_path against block's tx_root.
   * Returns null if validation fails or prerequisites are not met.
   */
  private async tryTxPathValidation(
    absoluteOffset: number,
    requestAttributes: RequestAttributes | undefined,
    parentSpan: Span,
  ): Promise<TxPathValidatedResult | null> {
    const span = startChildSpan(
      'ChunkRetrievalService.tryTxPathValidation',
      { attributes: { 'chunk.absolute_offset': absoluteOffset } },
      parentSpan,
    );

    try {
      span.addEvent('Starting tx_path validation');
      const txPathValidationStart = Date.now();

      // Step 1: Fetch unvalidated chunk from source
      const unvalidatedChunk =
        await this.unvalidatedChunkSource!.getUnvalidatedChunk(
          absoluteOffset,
          requestAttributes,
        );

      span.addEvent('Fetched unvalidated chunk', {
        has_tx_path: unvalidatedChunk.tx_path !== undefined,
        source: unvalidatedChunk.source,
      });

      if (!unvalidatedChunk.tx_path) {
        span.addEvent('No tx_path in chunk - cannot validate');
        return null;
      }

      // Step 2: Get block info for tx_root validation
      const containingBlock =
        await this.arweaveClient!.binarySearchBlocks(absoluteOffset);

      if (!containingBlock || !containingBlock.tx_root) {
        span.addEvent('Block not found or missing tx_root');
        return null;
      }

      const blockHeight = containingBlock.height;
      const blockWeaveSize = parseInt(containingBlock.weave_size);
      const blockTxs: string[] = containingBlock.txs || [];
      const txRoot = fromB64Url(containingBlock.tx_root);

      // Get previous block's weave_size for block start boundary
      let prevBlockWeaveSize = 0;
      if (blockHeight > 0) {
        const prevBlock = await this.arweaveClient!.getBlockByHeight(
          blockHeight - 1,
        );
        if (prevBlock !== undefined) {
          prevBlockWeaveSize = parseInt(prevBlock.weave_size);
        }
      }

      span.addEvent('Got block info', {
        block_height: blockHeight,
        block_tx_count: blockTxs.length,
      });

      // Step 3: Parse and validate tx_path against block's tx_root
      const parsedTxPath = await parseTxPath({
        txRoot,
        txPath: unvalidatedChunk.tx_path,
        targetOffset: BigInt(absoluteOffset),
        blockWeaveSize: BigInt(blockWeaveSize),
        prevBlockWeaveSize: BigInt(prevBlockWeaveSize),
        txCount: blockTxs.length,
      });

      if (!parsedTxPath || !parsedTxPath.validated) {
        span.addEvent('tx_path validation failed');
        return null;
      }

      // Convert BigInt values to numbers for API compatibility
      const txSize = safeBigIntToNumber(parsedTxPath.txSize, 'txSize');
      const txStartOffset = safeBigIntToNumber(
        parsedTxPath.txStartOffset,
        'txStartOffset',
      );
      const txEndOffset = safeBigIntToNumber(
        parsedTxPath.txEndOffset,
        'txEndOffset',
      );

      span.addEvent('tx_path validation successful', {
        tx_size: txSize,
        tx_start_offset: txStartOffset,
        tx_end_offset: txEndOffset,
      });

      // Extract TX info from validated tx_path
      const dataRootFromTxPath = parsedTxPath.dataRoot;
      const relativeOffset = absoluteOffset - txStartOffset;

      // Step 4: Validate data_path against dataRoot
      await validateChunk(
        txSize,
        {
          chunk: unvalidatedChunk.chunk,
          data_path: unvalidatedChunk.data_path,
        },
        dataRootFromTxPath,
        relativeOffset,
      );

      span.addEvent('data_path validation successful');

      // Step 5: Cache validated chunk with absoluteOffset
      const dataRootB64 = toB64Url(dataRootFromTxPath);

      await Promise.all([
        this.chunkDataStore!.set(
          dataRootB64,
          relativeOffset,
          {
            hash: unvalidatedChunk.hash,
            chunk: unvalidatedChunk.chunk,
          },
          absoluteOffset,
        ),
        this.chunkMetadataStore!.set(
          {
            data_root: dataRootFromTxPath,
            data_size: txSize,
            data_path: unvalidatedChunk.data_path,
            offset: relativeOffset,
            hash: unvalidatedChunk.hash,
            tx_path: unvalidatedChunk.tx_path,
          },
          absoluteOffset,
        ),
      ]);

      span.addEvent('Cached validated chunk');

      // Construct validated Chunk
      const chunk: Chunk = {
        hash: unvalidatedChunk.hash,
        chunk: unvalidatedChunk.chunk,
        data_root: dataRootFromTxPath,
        data_size: txSize,
        data_path: unvalidatedChunk.data_path,
        offset: relativeOffset,
        tx_path: unvalidatedChunk.tx_path,
        source: unvalidatedChunk.source,
        sourceHost: unvalidatedChunk.sourceHost,
      };

      const txPathValidationDuration = Date.now() - txPathValidationStart;
      span.setAttribute(
        'chunk.tx_path_validation_duration_ms',
        txPathValidationDuration,
      );

      this.log.debug('Fast path tx_path validation successful', {
        absoluteOffset,
        dataRoot: dataRootB64,
        relativeOffset,
        txSize,
        durationMs: txPathValidationDuration,
      });

      return {
        type: 'tx_path_validated',
        chunk,
        dataRoot: dataRootB64,
        dataSize: txSize,
        weaveOffset: txEndOffset,
        relativeOffset,
        contiguousDataStartDelimiter: txStartOffset,
      };
    } catch (error: any) {
      span.recordException(error);
      this.log.debug('tx_path validation failed', {
        absoluteOffset,
        error: error.message,
      });
      return null;
    } finally {
      span.end();
    }
  }

  /**
   * Fallback path using txOffsetSource to look up TX info, then fetch chunk.
   * Always returns a result or throws ChunkNotFoundError.
   */
  private async fallbackPath(
    absoluteOffset: number,
    requestAttributes: RequestAttributes | undefined,
    parentSpan: Span,
  ): Promise<FallbackResult> {
    const span = startChildSpan(
      'ChunkRetrievalService.fallbackPath',
      { attributes: { 'chunk.absolute_offset': absoluteOffset } },
      parentSpan,
    );

    try {
      span.addEvent('Looking up TX by offset');

      // Get transaction info using composite source
      let txResult;
      try {
        txResult = await this.txOffsetSource.getTxByOffset(absoluteOffset);
      } catch (error: any) {
        this.log.debug('Transaction offset lookup failed', {
          offset: absoluteOffset,
          error: error.message,
        });
        throw new ChunkNotFoundError(
          `Transaction offset lookup failed: ${error.message}`,
          'offset_lookup_failed',
        );
      }

      const { data_root, id, data_size, offset: weaveOffset } = txResult;

      // Check if result is valid
      if (
        data_root === undefined ||
        weaveOffset === undefined ||
        id === undefined ||
        data_size === undefined
      ) {
        span.addEvent('Transaction not found');
        throw new ChunkNotFoundError(
          'Transaction not found for offset',
          'tx_not_found',
        );
      }

      // Calculate the relative offset
      const contiguousDataStartDelimiter = weaveOffset - data_size + 1;
      const relativeOffset = absoluteOffset - contiguousDataStartDelimiter;

      span.setAttributes({
        'chunk.tx_id': id,
        'chunk.data_root': data_root,
        'chunk.data_size': data_size,
        'chunk.weave_offset': weaveOffset,
        'chunk.relative_offset': relativeOffset,
      });

      // Fetch the chunk data
      span.addEvent('Starting chunk retrieval');
      const chunkRetrievalStart = Date.now();

      let chunk: Chunk;
      try {
        chunk = await this.chunkSource.getChunkByAny({
          txSize: data_size,
          absoluteOffset,
          dataRoot: data_root,
          relativeOffset,
          requestAttributes,
        });
      } catch (error: any) {
        const retrievalDuration = Date.now() - chunkRetrievalStart;
        span.setAttribute('chunk.retrieval.duration_ms', retrievalDuration);
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
        type: 'fallback',
        chunk,
        txId: id,
        dataRoot: data_root,
        dataSize: data_size,
        weaveOffset,
        relativeOffset,
        contiguousDataStartDelimiter,
      };
    } catch (error: any) {
      if (!(error instanceof ChunkNotFoundError)) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }
}
