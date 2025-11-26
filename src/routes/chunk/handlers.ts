/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import {
  CHUNK_GET_BASE64_SIZE_BYTES,
  CHUNK_POST_ABORT_TIMEOUT_MS,
  CHUNK_POST_RESPONSE_TIMEOUT_MS,
  CHUNK_POST_MIN_SUCCESS_COUNT,
  MAX_CHUNK_SIZE,
} from '../../config.js';
import { headerNames } from '../../constants.js';
import { formatContentDigest } from '../../lib/digest.js';
import { fromB64Url, toB64Url } from '../../lib/encoding.js';
import {
  Chunk,
  ChunkByAnySource,
  ChunkDataStore,
  ChunkMetadataStore,
  TxOffsetSource,
  UnvalidatedChunkSource,
} from '../../types.js';
import { ArweaveCompositeClient } from '../../arweave/composite-client.js';
import { Logger } from 'winston';
import { tracer } from '../../tracing.js';
import { getRequestAttributes } from '../data/handlers.js';
import { RateLimiter } from '../../limiter/types.js';
import { PaymentProcessor } from '../../payments/types.js';
import {
  checkPaymentAndRateLimits,
  adjustRateLimitTokens,
} from '../../handlers/data-handler-utils.js';
import { handleIfNoneMatch, parseContentLength } from '../../lib/http-utils.js';
import { parseDataPath } from '../../lib/merkle-path-parser.js';
import { parseTxPath, safeBigIntToNumber } from '../../lib/tx-path-parser.js';
import { validateChunk } from '../../lib/validation.js';

export const createChunkOffsetHandler = ({
  chunkSource,
  txOffsetSource,
  rateLimiter,
  paymentProcessor,
  log,
  // Optional dependencies for tx_path validation fast path
  chunkDataStore,
  chunkMetadataStore,
  arweaveClient,
  unvalidatedChunkSource,
}: {
  chunkSource: ChunkByAnySource;
  txOffsetSource: TxOffsetSource;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  log: Logger;
  // Optional dependencies for tx_path validation fast path
  chunkDataStore?: ChunkDataStore;
  chunkMetadataStore?: ChunkMetadataStore;
  arweaveClient?: ArweaveCompositeClient;
  unvalidatedChunkSource?: UnvalidatedChunkSource;
}) => {
  return asyncHandler(async (request: Request, response: Response) => {
    const span = tracer.startSpan('ChunkOffsetHandler.handle', {
      attributes: {
        'http.method': request.method,
        'http.target': request.originalUrl,
        'chunk.offset': request.params.offset,
      },
    });

    try {
      const offset = Number.parseInt(request.params.offset);

      if (Number.isNaN(offset) || offset < 0) {
        span.setAttribute('http.status_code', 400);
        span.setAttribute('chunk.retrieval.error', 'invalid_offset');
        response.status(400).send('Invalid offset');
        return;
      }

      span.setAttribute('chunk.absolute_offset', offset);

      // Extract request attributes for hop tracking
      const requestAttributes = getRequestAttributes(request, response);

      // === PAYMENT AND RATE LIMIT CHECK ===
      // Only perform checks if at least one enforcement mechanism is configured
      if (rateLimiter !== undefined || paymentProcessor !== undefined) {
        // For HEAD requests, use zero tokens since no body is sent
        // For GET requests, use fixed size assumption
        // NOTE: Unlike data requests, we cannot reliably predict 304 Not Modified
        // responses for chunks before fetching, since we don't have the chunk hash
        // until after retrieval. This means some GET requests with If-None-Match
        // that would return 304 might be charged/denied upfront. Tokens are adjusted
        // to zero in the finish handler if 304 is returned (see line 146).
        const contentSize =
          request.method === 'HEAD' ? 0 : CHUNK_GET_BASE64_SIZE_BYTES;

        const limitCheck = await checkPaymentAndRateLimits({
          req: request,
          res: response,
          // id is omitted - will be added to logs after txResult fetch
          contentSize,
          contentType: undefined, // Chunks don't have content type
          requestAttributes,
          rateLimiter,
          paymentProcessor,
          parentSpan: span,
          // Use direct payment flow for browser requests (payment to original URL)
          // This reduces latency for small chunk requests by avoiding redirect overhead
          browserPaymentFlow: 'direct',
        });

        if (!limitCheck.allowed) {
          // Payment required (402) or rate limit exceeded (429) response already sent
          return;
        }

        // Schedule token adjustment based on actual response size
        if (rateLimiter && limitCheck.ipTokensConsumed !== undefined) {
          response.on('finish', () => {
            // Calculate actual response size based on status code
            let actualSize = 0;
            if (response.statusCode === 304 || request.method === 'HEAD') {
              // 304 Not Modified or HEAD request - no body sent
              // Note: adjustTokens will still consume minimum 1 token to prevent spam
              actualSize = 0;
            } else if (response.statusCode === 200) {
              // GET request with body - calculate JSON response size
              const headers = {
                'content-length': response.getHeader('content-length'),
              };
              const contentLength = parseContentLength(headers);
              if (contentLength !== undefined) {
                actualSize = contentLength;
              }
            }

            adjustRateLimitTokens({
              req: request,
              responseSize: actualSize,
              initialResult: limitCheck,
              rateLimiter,
            });
          });
        }
      }

      // Variables to be populated by either fast path or fallback path
      let chunk: Chunk | undefined = undefined;
      let finalDataRoot: string | undefined;
      let finalId: string | undefined;
      let finalDataSize: number | undefined;
      let finalWeaveOffset: number | undefined;
      let relativeOffset: number | undefined;
      let contiguousDataStartDelimiter: number | undefined;
      let usedFastPath = false;

      // === FAST PATH: Cache lookup by absoluteOffset ===
      // If tx_path validation dependencies are available, try the fast path first
      if (chunkDataStore && chunkMetadataStore) {
        span.addEvent('Trying fast path - cache lookup by absoluteOffset');
        const cacheCheckStart = Date.now();

        // Parallel lookup in both caches
        const [cachedChunkData, cachedChunkMetadata] = await Promise.all([
          chunkDataStore.getByAbsoluteOffset(offset),
          chunkMetadataStore.getByAbsoluteOffset(offset),
        ]);

        const cacheCheckDuration = Date.now() - cacheCheckStart;
        span.setAttribute('chunk.cache_check_duration_ms', cacheCheckDuration);

        if (cachedChunkData && cachedChunkMetadata) {
          // Cache hit! Chunk was previously validated when cached
          span.addEvent('Cache hit by absoluteOffset', {
            cache_check_duration_ms: cacheCheckDuration,
          });
          span.setAttribute('chunk.fast_path', 'cache_hit');

          // Derive TX boundaries from cached metadata
          relativeOffset = cachedChunkMetadata.offset;
          finalDataSize = cachedChunkMetadata.data_size;
          finalDataRoot = toB64Url(cachedChunkMetadata.data_root);

          // Calculate weave offsets from absoluteOffset and relativeOffset
          contiguousDataStartDelimiter = offset - relativeOffset;
          finalWeaveOffset = contiguousDataStartDelimiter + finalDataSize - 1;

          // Construct Chunk from cached data + metadata
          chunk = {
            ...cachedChunkData,
            ...cachedChunkMetadata,
            source: 'cache',
            sourceHost: undefined,
          };
          usedFastPath = true;

          log.debug('Fast path cache hit', {
            absoluteOffset: offset,
            dataRoot: finalDataRoot,
            relativeOffset,
          });
        } else if (unvalidatedChunkSource && arweaveClient) {
          // Cache miss - try tx_path validation path
          span.addEvent('Cache miss - trying tx_path validation', {
            cache_check_duration_ms: cacheCheckDuration,
          });

          try {
            const txPathValidationStart = Date.now();

            // Step 1: Fetch unvalidated chunk from source
            const unvalidatedChunk =
              await unvalidatedChunkSource.getUnvalidatedChunk(
                offset,
                requestAttributes,
              );

            span.addEvent('Fetched unvalidated chunk', {
              has_tx_path: unvalidatedChunk.tx_path !== undefined,
              source: unvalidatedChunk.source,
            });

            if (unvalidatedChunk.tx_path) {
              // Step 2: Get block info for tx_root validation
              const containingBlock =
                await arweaveClient.binarySearchBlocks(offset);

              if (containingBlock && containingBlock.tx_root) {
                const blockHeight = containingBlock.height;
                const blockWeaveSize = parseInt(containingBlock.weave_size);
                const blockTxs: string[] = containingBlock.txs || [];
                const txRoot = fromB64Url(containingBlock.tx_root);

                // Get previous block's weave_size for block start boundary
                let prevBlockWeaveSize = 0;
                if (blockHeight > 0) {
                  const prevBlock = await arweaveClient.getBlockByHeight(
                    blockHeight - 1,
                  );
                  if (prevBlock !== undefined) {
                    prevBlockWeaveSize = parseInt(prevBlock.weave_size);
                  }
                }

                span.addEvent('Got block info for tx_path validation', {
                  block_height: blockHeight,
                  block_tx_count: blockTxs.length,
                });

                // Step 3: Parse and validate tx_path against block's tx_root
                const parsedTxPath = await parseTxPath({
                  txRoot,
                  txPath: unvalidatedChunk.tx_path,
                  targetOffset: BigInt(offset),
                  blockWeaveSize: BigInt(blockWeaveSize),
                  prevBlockWeaveSize: BigInt(prevBlockWeaveSize),
                  txCount: blockTxs.length,
                });

                if (parsedTxPath && parsedTxPath.validated) {
                  // Convert BigInt values to numbers for API compatibility
                  // (throws if exceeds Number.MAX_SAFE_INTEGER)
                  const txSizeFromTxPath = safeBigIntToNumber(
                    parsedTxPath.txSize,
                    'txSize',
                  );
                  const txStartOffsetFromTxPath = safeBigIntToNumber(
                    parsedTxPath.txStartOffset,
                    'txStartOffset',
                  );
                  const txEndOffsetFromTxPath = safeBigIntToNumber(
                    parsedTxPath.txEndOffset,
                    'txEndOffset',
                  );

                  span.addEvent('tx_path validation successful', {
                    tx_size: txSizeFromTxPath,
                    tx_start_offset: txStartOffsetFromTxPath,
                    tx_end_offset: txEndOffsetFromTxPath,
                  });

                  // Extract TX info from validated tx_path
                  const dataRootFromTxPath = parsedTxPath.dataRoot;
                  const relativeOffsetFromTxPath =
                    offset - txStartOffsetFromTxPath;

                  // Step 4: Validate data_path against dataRoot
                  await validateChunk(
                    txSizeFromTxPath,
                    {
                      chunk: unvalidatedChunk.chunk,
                      data_path: unvalidatedChunk.data_path,
                    },
                    dataRootFromTxPath,
                    relativeOffsetFromTxPath,
                  );

                  span.addEvent('data_path validation successful');

                  // Step 5: Cache validated chunk with absoluteOffset
                  const dataRootB64 = toB64Url(dataRootFromTxPath);

                  await Promise.all([
                    chunkDataStore.set(
                      dataRootB64,
                      relativeOffsetFromTxPath,
                      {
                        hash: unvalidatedChunk.hash,
                        chunk: unvalidatedChunk.chunk,
                      },
                      offset,
                    ),
                    chunkMetadataStore.set(
                      {
                        data_root: dataRootFromTxPath,
                        data_size: txSizeFromTxPath,
                        data_path: unvalidatedChunk.data_path,
                        offset: relativeOffsetFromTxPath,
                        hash: unvalidatedChunk.hash,
                        tx_path: unvalidatedChunk.tx_path,
                      },
                      offset,
                    ),
                  ]);

                  span.addEvent('Cached validated chunk with absoluteOffset');

                  // Populate variables for response
                  finalDataRoot = dataRootB64;
                  finalDataSize = txSizeFromTxPath;
                  relativeOffset = relativeOffsetFromTxPath;
                  contiguousDataStartDelimiter = txStartOffsetFromTxPath;
                  finalWeaveOffset = txEndOffsetFromTxPath;

                  // Construct validated Chunk
                  chunk = {
                    hash: unvalidatedChunk.hash,
                    chunk: unvalidatedChunk.chunk,
                    data_root: dataRootFromTxPath,
                    data_size: txSizeFromTxPath,
                    data_path: unvalidatedChunk.data_path,
                    offset: relativeOffsetFromTxPath,
                    tx_path: unvalidatedChunk.tx_path,
                    source: unvalidatedChunk.source,
                    sourceHost: unvalidatedChunk.sourceHost,
                  };
                  usedFastPath = true;

                  const txPathValidationDuration =
                    Date.now() - txPathValidationStart;
                  span.setAttribute('chunk.fast_path', 'tx_path_validated');
                  span.setAttribute(
                    'chunk.tx_path_validation_duration_ms',
                    txPathValidationDuration,
                  );

                  log.debug('Fast path tx_path validation successful', {
                    absoluteOffset: offset,
                    dataRoot: finalDataRoot,
                    relativeOffset,
                    txSize: finalDataSize,
                    durationMs: txPathValidationDuration,
                  });
                } else {
                  span.addEvent('tx_path validation failed - falling back');
                  span.setAttribute('chunk.fast_path', 'tx_path_invalid');
                }
              } else {
                span.addEvent(
                  'Block not found or missing tx_root - falling back',
                );
                span.setAttribute('chunk.fast_path', 'block_not_found');
              }
            } else {
              span.addEvent('No tx_path in chunk - falling back');
              span.setAttribute('chunk.fast_path', 'no_tx_path');
            }
          } catch (error: any) {
            span.addEvent('Fast path failed', { error: error.message });
            span.setAttribute('chunk.fast_path', 'error');
            log.debug('Fast path tx_path validation failed', {
              absoluteOffset: offset,
              error: error.message,
            });
            // Fall through to legacy path
          }
        }
      }

      // === FALLBACK PATH: Traditional txOffsetSource flow ===
      if (!usedFastPath) {
        span.addEvent('Using fallback path - txOffsetSource');

        // Get transaction info using composite source (database with chain fallback)
        let txResult;
        try {
          txResult = await txOffsetSource.getTxByOffset(offset);
        } catch (error: any) {
          log.debug('Transaction offset lookup failed', {
            offset,
            error: error.message,
          });
          span.setAttribute('http.status_code', 404);
          span.setAttribute('chunk.retrieval.error', 'offset_lookup_failed');
          response.sendStatus(404);
          return;
        }

        const { data_root, id, data_size, offset: weaveOffset } = txResult;

        // Check if result is valid
        if (
          data_root === undefined ||
          weaveOffset === undefined ||
          id === undefined ||
          data_size === undefined
        ) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('chunk.retrieval.error', 'tx_not_found');
          span.addEvent('Transaction not found');
          response.sendStatus(404);
          return;
        }

        finalDataRoot = data_root;
        finalId = id;
        finalDataSize = data_size;
        finalWeaveOffset = weaveOffset;

        // Calculate the relative offset, needed for chunk data source
        contiguousDataStartDelimiter = finalWeaveOffset - finalDataSize + 1;
        relativeOffset = offset - contiguousDataStartDelimiter;

        span.setAttributes({
          'chunk.tx_id': finalId,
          'chunk.data_root': finalDataRoot,
          'chunk.data_size': finalDataSize,
          'chunk.weave_offset': finalWeaveOffset,
          'chunk.relative_offset': relativeOffset,
        });

        // actually fetch the chunk data
        span.addEvent('Starting chunk retrieval');
        const chunkRetrievalStart = Date.now();

        try {
          chunk = await chunkSource.getChunkByAny({
            txSize: finalDataSize,
            absoluteOffset: offset,
            dataRoot: finalDataRoot,
            relativeOffset,
            requestAttributes,
          });
        } catch (error: any) {
          const retrievalDuration = Date.now() - chunkRetrievalStart;
          span.setAttributes({
            'http.status_code': 404,
            'chunk.retrieval.error': 'fetch_failed',
            'chunk.retrieval.duration_ms': retrievalDuration,
          });
          span.recordException(error);
          response.sendStatus(404);
          return;
        }

        const retrievalDuration = Date.now() - chunkRetrievalStart;
        span.setAttribute('chunk.retrieval.duration_ms', retrievalDuration);
      }

      // Set span attributes for TX info (may be undefined for fast path cache hit)
      if (finalId !== undefined) {
        span.setAttribute('chunk.tx_id', finalId);
      }
      if (finalDataRoot !== undefined) {
        span.setAttribute('chunk.data_root', finalDataRoot);
      }
      if (finalDataSize !== undefined) {
        span.setAttribute('chunk.data_size', finalDataSize);
      }
      if (finalWeaveOffset !== undefined) {
        span.setAttribute('chunk.weave_offset', finalWeaveOffset);
      }
      if (relativeOffset !== undefined) {
        span.setAttribute('chunk.relative_offset', relativeOffset);
      }

      if (chunk === undefined) {
        span.setAttribute('http.status_code', 404);
        span.setAttribute('chunk.retrieval.error', 'chunk_undefined');
        response.sendStatus(404);
        return;
      }

      span.addEvent('Chunk retrieval successful');

      // Track chunk source information
      if (chunk.source !== undefined) {
        span.setAttribute('chunk.source', chunk.source);
      }
      if (chunk.sourceHost !== undefined) {
        span.setAttribute('chunk.source_host', chunk.sourceHost);
      }

      let chunkBase64Url: string | undefined = undefined;
      let dataPath: string | undefined = undefined;

      try {
        chunkBase64Url = toB64Url(chunk.chunk);
        span.setAttribute('chunk.encoded_size', chunkBase64Url.length);
      } catch (error: any) {
        span.setAttribute('http.status_code', 500);
        span.setAttribute('chunk.retrieval.error', 'encoding_failed');
        span.recordException(error);
        log.error('Error converting chunk to base64url', { error });
        response.status(500).send('Error converting chunk to base64url');
        return;
      }

      try {
        dataPath = toB64Url(chunk.data_path);
      } catch (error: any) {
        span.setAttribute('http.status_code', 500);
        span.setAttribute('chunk.retrieval.error', 'datapath_encoding_failed');
        span.recordException(error);
        log.error('Error getting data path from chunk', { error });
        response.status(500).send('Error converting data path to base64url');
        return;
      }

      let txPath: string | undefined = undefined;
      if (chunk.tx_path !== undefined) {
        try {
          txPath = toB64Url(chunk.tx_path);
        } catch (error: any) {
          span.setAttribute('http.status_code', 500);
          span.setAttribute('chunk.retrieval.error', 'txpath_encoding_failed');
          span.recordException(error);
          log.error('Error getting tx path from chunk', { error });
          response.status(500).send('Error converting tx path to base64url');
          return;
        }
      }

      // Add source tracking headers
      if (chunk.source !== undefined && chunk.source !== '') {
        response.setHeader(headerNames.chunkSourceType, chunk.source);
      }
      if (chunk.sourceHost !== undefined && chunk.sourceHost !== '') {
        response.setHeader(headerNames.chunkHost, chunk.sourceHost);
      }

      // Set cache status header
      const cacheStatus = chunk.source === 'cache' ? 'HIT' : 'MISS';
      response.setHeader(headerNames.cache, cacheStatus);
      span.setAttribute('chunk.cache_status', cacheStatus);

      // Add ETag header when hash is available
      // Only add when data is cached OR it's a HEAD request (to prevent incorrect hashes on streamed data)
      if (
        chunk.hash !== undefined &&
        (chunk.source === 'cache' || request.method === 'HEAD')
      ) {
        const hashString = toB64Url(chunk.hash);
        response.setHeader('ETag', `"${hashString}"`);
        span.setAttribute('chunk.hash', hashString);
      }

      // Set content type and prepare response data
      response.setHeader('Content-Type', 'application/json; charset=utf-8');

      // Calculate Content-Length for HEAD requests
      const responseBody = {
        chunk: chunkBase64Url,
        ...(dataPath !== undefined && {
          data_path: dataPath,
        }),
        ...(txPath !== undefined && {
          tx_path: txPath,
        }),
        // as of today, ar-io-node doesn't pack chunks
        packing: 'unpacked',
      };
      const responseBodyString = JSON.stringify(responseBody);
      response.setHeader(
        'Content-Length',
        Buffer.byteLength(responseBodyString).toString(),
      );

      // Handle conditional requests (If-None-Match)
      if (handleIfNoneMatch(request, response)) {
        span.setAttribute('http.status_code', 304);
        span.addEvent('Conditional request - not modified');
        response.end();
        return;
      }

      span.setAttributes({
        'http.status_code': 200,
        'chunk.raw_size': chunk.chunk.length,
      });

      // Handle HEAD request - return headers only, no body
      if (request.method === 'HEAD') {
        span.addEvent('HEAD request - headers only');
        response.status(200).end();
        return;
      }

      span.addEvent('Chunk response successful');

      // Send the full response for GET requests
      // We manually send JSON to preserve our custom ETag
      response.status(200).send(responseBodyString);
    } catch (error: any) {
      span.recordException(error);
      span.setAttribute('http.status_code', 500);
      log.error('Unexpected error in chunk offset handler', {
        message: error?.message,
        stack: error?.stack,
      });
      response.status(500).send('Internal server error');
    } finally {
      span.end();
    }
  });
};

/**
 * Creates a handler for the raw binary chunk data endpoint (GET/HEAD /chunk/:offset/data).
 *
 * This endpoint serves chunk data in raw binary format (application/octet-stream) instead of
 * base64url-encoded JSON, providing approximately 40% bandwidth savings. All chunk metadata
 * is provided via HTTP headers instead of a JSON response body.
 *
 * Rate limiting uses MAX_CHUNK_SIZE (256 KiB) instead of CHUNK_GET_BASE64_SIZE_BYTES (360 KiB)
 * used by the base64 endpoint, reflecting the smaller response size.
 *
 * @param chunkSource - Source for retrieving chunk data
 * @param txOffsetSource - Source for looking up transaction offset information
 * @param rateLimiter - Optional rate limiter for request throttling
 * @param paymentProcessor - Optional payment processor for x402 protocol
 * @param log - Logger instance for request logging
 *
 * @returns Express route handler
 *
 * @remarks
 * Response headers:
 * - `Content-Type`: Always `application/octet-stream`
 * - `Content-Length`: Size of the returned chunk in bytes
 * - `X-Arweave-Chunk-Data-Path`: Base64url-encoded merkle proof path for the chunk
 * - `X-Arweave-Chunk-Data-Root`: Base64url-encoded merkle tree root hash
 * - `X-Arweave-Chunk-Start-Offset`: Absolute start offset in the weave (inclusive, 0-based)
 * - `X-Arweave-Chunk-Relative-Start-Offset`: Relative start offset within the transaction
 * - `X-Arweave-Chunk-Read-Offset`: Position to start reading within the returned chunk
 * - `X-Arweave-Chunk-Tx-Data-Size`: Total transaction data size in bytes
 * - `X-Arweave-Chunk-Tx-Id`: Transaction ID containing this chunk
 * - `X-Arweave-Chunk-Tx-Start-Offset`: Absolute start offset of the transaction in the weave
 * - `X-Arweave-Chunk-Tx-Path`: Base64url-encoded transaction-level merkle path (if available)
 * - `ETag`: Base64url chunk hash (only for cached data or HEAD requests)
 * - `Content-Digest`: RFC 9530 format SHA-256 hash (only for cached data or HEAD requests)
 *
 * End offsets can be calculated from Content-Length:
 * - Exclusive: `start_offset + Content-Length`
 * - Inclusive: `start_offset + Content-Length - 1`
 *
 * Supports conditional requests via `If-None-Match` header, returning 304 Not Modified when
 * the ETag matches.
 */
export const createChunkOffsetDataHandler = ({
  chunkSource,
  txOffsetSource,
  rateLimiter,
  paymentProcessor,
  log,
  // Optional dependencies for tx_path validation fast path
  chunkDataStore,
  chunkMetadataStore,
  arweaveClient,
  unvalidatedChunkSource,
}: {
  chunkSource: ChunkByAnySource;
  txOffsetSource: TxOffsetSource;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  log: Logger;
  // Optional dependencies for tx_path validation fast path
  chunkDataStore?: ChunkDataStore;
  chunkMetadataStore?: ChunkMetadataStore;
  arweaveClient?: ArweaveCompositeClient;
  unvalidatedChunkSource?: UnvalidatedChunkSource;
}) => {
  return asyncHandler(async (request: Request, response: Response) => {
    const span = tracer.startSpan('ChunkOffsetDataHandler.handle', {
      attributes: {
        'http.method': request.method,
        'http.target': request.originalUrl,
        'chunk.offset': request.params.offset,
      },
    });

    try {
      const offset = Number.parseInt(request.params.offset);

      if (Number.isNaN(offset) || offset < 0) {
        span.setAttribute('http.status_code', 400);
        span.setAttribute('chunk.retrieval.error', 'invalid_offset');
        response.status(400).send('Invalid offset');
        return;
      }

      span.setAttribute('chunk.absolute_offset', offset);

      // Extract request attributes for hop tracking
      const requestAttributes = getRequestAttributes(request, response);

      // === PAYMENT AND RATE LIMIT CHECK ===
      // Only perform checks if at least one enforcement mechanism is configured
      if (rateLimiter !== undefined || paymentProcessor !== undefined) {
        // For HEAD requests, use zero tokens since no body is sent
        // For GET requests, use raw chunk size (not base64 encoded)
        // NOTE: Unlike data requests, we cannot reliably predict 304 Not Modified
        // responses for chunks before fetching, since we don't have the chunk hash
        // until after retrieval. This means some GET requests with If-None-Match
        // that would return 304 might be charged/denied upfront. Tokens are adjusted
        // to zero in the finish handler if 304 is returned.
        const contentSize = request.method === 'HEAD' ? 0 : MAX_CHUNK_SIZE;

        const limitCheck = await checkPaymentAndRateLimits({
          req: request,
          res: response,
          // id is omitted - will be added to logs after txResult fetch
          contentSize,
          contentType: undefined, // Chunks don't have content type
          requestAttributes,
          rateLimiter,
          paymentProcessor,
          parentSpan: span,
          // Use direct payment flow for browser requests (payment to original URL)
          // This reduces latency for small chunk requests by avoiding redirect overhead
          browserPaymentFlow: 'direct',
        });

        if (!limitCheck.allowed) {
          // Payment required (402) or rate limit exceeded (429) response already sent
          return;
        }

        // Schedule token adjustment based on actual response size
        if (rateLimiter && limitCheck.ipTokensConsumed !== undefined) {
          response.on('finish', () => {
            // Calculate actual response size based on status code
            let actualSize = 0;
            if (response.statusCode === 304 || request.method === 'HEAD') {
              // 304 Not Modified or HEAD request - no body sent
              // Note: adjustTokens will still consume minimum 1 token to prevent spam
              actualSize = 0;
            } else if (response.statusCode === 200) {
              // GET request with body - use actual chunk size from headers
              const headers = {
                'content-length': response.getHeader('content-length'),
              };
              const contentLength = parseContentLength(headers);
              if (contentLength !== undefined) {
                actualSize = contentLength;
              }
            }

            adjustRateLimitTokens({
              req: request,
              responseSize: actualSize,
              initialResult: limitCheck,
              rateLimiter,
            });
          });
        }
      }

      // Variables to be populated by either fast path or fallback path
      let chunk: Chunk | undefined = undefined;
      let finalDataRoot: string | undefined;
      let finalId: string | undefined;
      let finalDataSize: number | undefined;
      let finalWeaveOffset: number | undefined;
      let relativeOffset: number | undefined;
      let contiguousDataStartDelimiter: number | undefined;
      let usedFastPath = false;

      // === FAST PATH: Cache lookup by absoluteOffset ===
      // If tx_path validation dependencies are available, try the fast path first
      if (chunkDataStore && chunkMetadataStore) {
        span.addEvent('Trying fast path - cache lookup by absoluteOffset');
        const cacheCheckStart = Date.now();

        // Parallel lookup in both caches
        const [cachedChunkData, cachedChunkMetadata] = await Promise.all([
          chunkDataStore.getByAbsoluteOffset(offset),
          chunkMetadataStore.getByAbsoluteOffset(offset),
        ]);

        const cacheCheckDuration = Date.now() - cacheCheckStart;
        span.setAttribute('chunk.cache_check_duration_ms', cacheCheckDuration);

        if (cachedChunkData && cachedChunkMetadata) {
          // Cache hit! Chunk was previously validated when cached
          span.addEvent('Cache hit by absoluteOffset', {
            cache_check_duration_ms: cacheCheckDuration,
          });
          span.setAttribute('chunk.fast_path', 'cache_hit');

          // Derive TX boundaries from cached metadata
          relativeOffset = cachedChunkMetadata.offset;
          finalDataSize = cachedChunkMetadata.data_size;
          finalDataRoot = toB64Url(cachedChunkMetadata.data_root);

          // Calculate weave offsets from absoluteOffset and relativeOffset
          contiguousDataStartDelimiter = offset - relativeOffset;
          finalWeaveOffset = contiguousDataStartDelimiter + finalDataSize - 1;

          // Construct Chunk from cached data + metadata
          chunk = {
            ...cachedChunkData,
            ...cachedChunkMetadata,
            source: 'cache',
            sourceHost: undefined,
          };
          usedFastPath = true;

          log.debug('Fast path cache hit', {
            absoluteOffset: offset,
            dataRoot: finalDataRoot,
            relativeOffset,
          });
        } else if (unvalidatedChunkSource && arweaveClient) {
          // Cache miss - try tx_path validation path
          span.addEvent('Cache miss - trying tx_path validation', {
            cache_check_duration_ms: cacheCheckDuration,
          });

          try {
            const txPathValidationStart = Date.now();

            // Step 1: Fetch unvalidated chunk from source
            const unvalidatedChunk =
              await unvalidatedChunkSource.getUnvalidatedChunk(
                offset,
                requestAttributes,
              );

            span.addEvent('Fetched unvalidated chunk', {
              has_tx_path: unvalidatedChunk.tx_path !== undefined,
              source: unvalidatedChunk.source,
            });

            if (unvalidatedChunk.tx_path) {
              // Step 2: Get block info for tx_root validation
              const containingBlock =
                await arweaveClient.binarySearchBlocks(offset);

              if (containingBlock && containingBlock.tx_root) {
                const blockHeight = containingBlock.height;
                const blockWeaveSize = parseInt(containingBlock.weave_size);
                const blockTxs: string[] = containingBlock.txs || [];
                const txRoot = fromB64Url(containingBlock.tx_root);

                // Get previous block's weave_size for block start boundary
                let prevBlockWeaveSize = 0;
                if (blockHeight > 0) {
                  const prevBlock = await arweaveClient.getBlockByHeight(
                    blockHeight - 1,
                  );
                  if (prevBlock !== undefined) {
                    prevBlockWeaveSize = parseInt(prevBlock.weave_size);
                  }
                }

                span.addEvent('Got block info for tx_path validation', {
                  block_height: blockHeight,
                  block_tx_count: blockTxs.length,
                });

                // Step 3: Parse and validate tx_path against block's tx_root
                const parsedTxPath = await parseTxPath({
                  txRoot,
                  txPath: unvalidatedChunk.tx_path,
                  targetOffset: BigInt(offset),
                  blockWeaveSize: BigInt(blockWeaveSize),
                  prevBlockWeaveSize: BigInt(prevBlockWeaveSize),
                  txCount: blockTxs.length,
                });

                if (parsedTxPath && parsedTxPath.validated) {
                  // Convert BigInt values to numbers for API compatibility
                  // (throws if exceeds Number.MAX_SAFE_INTEGER)
                  const txSizeFromTxPath = safeBigIntToNumber(
                    parsedTxPath.txSize,
                    'txSize',
                  );
                  const txStartOffsetFromTxPath = safeBigIntToNumber(
                    parsedTxPath.txStartOffset,
                    'txStartOffset',
                  );
                  const txEndOffsetFromTxPath = safeBigIntToNumber(
                    parsedTxPath.txEndOffset,
                    'txEndOffset',
                  );

                  span.addEvent('tx_path validation successful', {
                    tx_size: txSizeFromTxPath,
                    tx_start_offset: txStartOffsetFromTxPath,
                    tx_end_offset: txEndOffsetFromTxPath,
                  });

                  // Extract TX info from validated tx_path
                  const dataRootFromTxPath = parsedTxPath.dataRoot;
                  const relativeOffsetFromTxPath =
                    offset - txStartOffsetFromTxPath;

                  // Step 4: Validate data_path against dataRoot
                  await validateChunk(
                    txSizeFromTxPath,
                    {
                      chunk: unvalidatedChunk.chunk,
                      data_path: unvalidatedChunk.data_path,
                    },
                    dataRootFromTxPath,
                    relativeOffsetFromTxPath,
                  );

                  span.addEvent('data_path validation successful');

                  // Step 5: Cache validated chunk with absoluteOffset
                  const dataRootB64 = toB64Url(dataRootFromTxPath);

                  await Promise.all([
                    chunkDataStore.set(
                      dataRootB64,
                      relativeOffsetFromTxPath,
                      {
                        hash: unvalidatedChunk.hash,
                        chunk: unvalidatedChunk.chunk,
                      },
                      offset,
                    ),
                    chunkMetadataStore.set(
                      {
                        data_root: dataRootFromTxPath,
                        data_size: txSizeFromTxPath,
                        data_path: unvalidatedChunk.data_path,
                        offset: relativeOffsetFromTxPath,
                        hash: unvalidatedChunk.hash,
                        tx_path: unvalidatedChunk.tx_path,
                      },
                      offset,
                    ),
                  ]);

                  span.addEvent('Cached validated chunk with absoluteOffset');

                  // Populate variables for response
                  finalDataRoot = dataRootB64;
                  finalDataSize = txSizeFromTxPath;
                  relativeOffset = relativeOffsetFromTxPath;
                  contiguousDataStartDelimiter = txStartOffsetFromTxPath;
                  finalWeaveOffset = txEndOffsetFromTxPath;

                  // Construct validated Chunk
                  chunk = {
                    hash: unvalidatedChunk.hash,
                    chunk: unvalidatedChunk.chunk,
                    data_root: dataRootFromTxPath,
                    data_size: txSizeFromTxPath,
                    data_path: unvalidatedChunk.data_path,
                    offset: relativeOffsetFromTxPath,
                    tx_path: unvalidatedChunk.tx_path,
                    source: unvalidatedChunk.source,
                    sourceHost: unvalidatedChunk.sourceHost,
                  };
                  usedFastPath = true;

                  const txPathValidationDuration =
                    Date.now() - txPathValidationStart;
                  span.setAttribute('chunk.fast_path', 'tx_path_validated');
                  span.setAttribute(
                    'chunk.tx_path_validation_duration_ms',
                    txPathValidationDuration,
                  );

                  log.debug('Fast path tx_path validation successful', {
                    absoluteOffset: offset,
                    dataRoot: finalDataRoot,
                    relativeOffset,
                    txSize: finalDataSize,
                    durationMs: txPathValidationDuration,
                  });
                } else {
                  span.addEvent('tx_path validation failed - falling back');
                  span.setAttribute('chunk.fast_path', 'tx_path_invalid');
                }
              } else {
                span.addEvent(
                  'Block not found or missing tx_root - falling back',
                );
                span.setAttribute('chunk.fast_path', 'block_not_found');
              }
            } else {
              span.addEvent('No tx_path in chunk - falling back');
              span.setAttribute('chunk.fast_path', 'no_tx_path');
            }
          } catch (error: any) {
            span.addEvent('Fast path failed', { error: error.message });
            span.setAttribute('chunk.fast_path', 'error');
            log.debug('Fast path tx_path validation failed', {
              absoluteOffset: offset,
              error: error.message,
            });
            // Fall through to legacy path
          }
        }
      }

      // === FALLBACK PATH: Traditional txOffsetSource flow ===
      if (!usedFastPath) {
        span.addEvent('Using fallback path - txOffsetSource');

        // Get transaction info using composite source (database with chain fallback)
        let txResult;
        try {
          txResult = await txOffsetSource.getTxByOffset(offset);
        } catch (error: any) {
          log.debug('Transaction offset lookup failed', {
            offset,
            error: error.message,
          });
          span.setAttribute('http.status_code', 404);
          span.setAttribute('chunk.retrieval.error', 'offset_lookup_failed');
          response.sendStatus(404);
          return;
        }

        const { data_root, id, data_size, offset: weaveOffset } = txResult;

        // Check if result is valid
        if (
          data_root === undefined ||
          weaveOffset === undefined ||
          id === undefined ||
          data_size === undefined
        ) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('chunk.retrieval.error', 'tx_not_found');
          span.addEvent('Transaction not found');
          response.sendStatus(404);
          return;
        }

        finalDataRoot = data_root;
        finalId = id;
        finalDataSize = data_size;
        finalWeaveOffset = weaveOffset;

        // Calculate the relative offset, needed for chunk data source
        contiguousDataStartDelimiter = finalWeaveOffset - finalDataSize + 1;
        relativeOffset = offset - contiguousDataStartDelimiter;

        span.setAttributes({
          'chunk.tx_id': finalId,
          'chunk.data_root': finalDataRoot,
          'chunk.data_size': finalDataSize,
          'chunk.weave_offset': finalWeaveOffset,
          'chunk.relative_offset': relativeOffset,
        });

        // actually fetch the chunk data
        span.addEvent('Starting chunk retrieval');
        const chunkRetrievalStart = Date.now();

        try {
          chunk = await chunkSource.getChunkByAny({
            txSize: finalDataSize,
            absoluteOffset: offset,
            dataRoot: finalDataRoot,
            relativeOffset,
            requestAttributes,
          });
        } catch (error: any) {
          const retrievalDuration = Date.now() - chunkRetrievalStart;
          span.setAttributes({
            'http.status_code': 404,
            'chunk.retrieval.error': 'fetch_failed',
            'chunk.retrieval.duration_ms': retrievalDuration,
          });
          span.recordException(error);
          response.sendStatus(404);
          return;
        }

        const retrievalDuration = Date.now() - chunkRetrievalStart;
        span.setAttribute('chunk.retrieval.duration_ms', retrievalDuration);
      }

      // Set span attributes for TX info (may be undefined for fast path cache hit)
      if (finalId !== undefined) {
        span.setAttribute('chunk.tx_id', finalId);
      }
      if (finalDataRoot !== undefined) {
        span.setAttribute('chunk.data_root', finalDataRoot);
      }
      if (finalDataSize !== undefined) {
        span.setAttribute('chunk.data_size', finalDataSize);
      }
      if (finalWeaveOffset !== undefined) {
        span.setAttribute('chunk.weave_offset', finalWeaveOffset);
      }
      if (relativeOffset !== undefined) {
        span.setAttribute('chunk.relative_offset', relativeOffset);
      }

      if (chunk === undefined) {
        span.setAttribute('http.status_code', 404);
        span.setAttribute('chunk.retrieval.error', 'chunk_undefined');
        response.sendStatus(404);
        return;
      }

      span.addEvent('Chunk retrieval successful');

      // Track chunk source information
      if (chunk.source !== undefined) {
        span.setAttribute('chunk.source', chunk.source);
      }
      if (chunk.sourceHost !== undefined) {
        span.setAttribute('chunk.source_host', chunk.sourceHost);
      }

      // Ensure we have the required values for response headers
      if (
        finalDataRoot === undefined ||
        finalDataSize === undefined ||
        relativeOffset === undefined ||
        contiguousDataStartDelimiter === undefined
      ) {
        span.setAttribute('http.status_code', 500);
        span.setAttribute('chunk.retrieval.error', 'missing_tx_info');
        log.error('Missing TX info after chunk retrieval');
        response.status(500).send('Internal error: missing TX info');
        return;
      }

      // Parse merkle path to extract chunk boundaries
      let parsed;
      try {
        parsed = await parseDataPath({
          dataRoot: Buffer.from(finalDataRoot, 'base64url'),
          dataSize: finalDataSize,
          dataPath: chunk.data_path,
          offset: relativeOffset,
        });
      } catch (error: any) {
        span.setAttribute('http.status_code', 500);
        span.setAttribute('chunk.retrieval.error', 'merkle_path_parse_failed');
        span.recordException(error);
        log.error('Error parsing merkle path', { error });
        response.status(500).send('Error parsing merkle path');
        return;
      }

      const { startOffset, chunkSize } = parsed.boundaries;

      // Calculate absolute offsets in the weave
      const absoluteStartOffset = contiguousDataStartDelimiter + startOffset;

      // Calculate read offset within the returned chunk
      const readOffset = relativeOffset - startOffset;

      span.setAttributes({
        'chunk.start_offset': absoluteStartOffset,
        'chunk.tx_start_offset': startOffset,
        'chunk.read_offset': readOffset,
        'chunk.size': chunkSize,
      });

      // Set content type for raw binary data
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', chunk.chunk.length.toString());

      // Set chunk metadata headers
      response.setHeader(headerNames.chunkDataPath, toB64Url(chunk.data_path));
      response.setHeader(headerNames.chunkDataRoot, toB64Url(chunk.data_root));
      response.setHeader(
        headerNames.chunkStartOffset,
        absoluteStartOffset.toString(),
      );
      response.setHeader(
        headerNames.chunkRelativeStartOffset,
        startOffset.toString(),
      );
      response.setHeader(headerNames.chunkReadOffset, readOffset.toString());
      response.setHeader(headerNames.chunkTxDataSize, finalDataSize.toString());
      // TX ID may be undefined for fast path cache hits (not stored in cache)
      if (finalId !== undefined) {
        response.setHeader(headerNames.chunkTxId, finalId);
      }
      response.setHeader(
        headerNames.chunkTxStartOffset,
        contiguousDataStartDelimiter.toString(),
      );

      // Set tx_path header if available
      if (chunk.tx_path !== undefined) {
        response.setHeader(headerNames.chunkTxPath, toB64Url(chunk.tx_path));
      } else {
        response.setHeader(headerNames.chunkTxPath, '');
      }

      // Add source tracking headers
      if (chunk.source !== undefined && chunk.source !== '') {
        response.setHeader(headerNames.chunkSourceType, chunk.source);
      }
      if (chunk.sourceHost !== undefined && chunk.sourceHost !== '') {
        response.setHeader(headerNames.chunkHost, chunk.sourceHost);
      }

      // Set cache status header
      const cacheStatus = chunk.source === 'cache' ? 'HIT' : 'MISS';
      response.setHeader(headerNames.cache, cacheStatus);
      span.setAttribute('chunk.cache_status', cacheStatus);

      // Add ETag and Content-Digest headers when hash is available
      // Only add when data is cached OR it's a HEAD request (to prevent incorrect hashes on streamed data)
      if (
        chunk.hash !== undefined &&
        (chunk.source === 'cache' || request.method === 'HEAD')
      ) {
        const hashString = toB64Url(chunk.hash);
        response.setHeader('ETag', `"${hashString}"`);
        response.setHeader(
          headerNames.contentDigest,
          formatContentDigest(hashString),
        );
        span.setAttribute('chunk.hash', hashString);
      }

      // Handle conditional requests (If-None-Match)
      if (handleIfNoneMatch(request, response)) {
        span.setAttribute('http.status_code', 304);
        span.addEvent('Conditional request - not modified');
        response.end();
        return;
      }

      span.setAttributes({
        'http.status_code': 200,
        'chunk.raw_size': chunk.chunk.length,
      });

      // Handle HEAD request - return headers only, no body
      if (request.method === 'HEAD') {
        span.addEvent('HEAD request - headers only');
        response.status(200).end();
        return;
      }

      span.addEvent('Chunk response successful');

      // Send the raw binary chunk data
      response.status(200).send(chunk.chunk);
    } catch (error: any) {
      span.recordException(error);
      span.setAttribute('http.status_code', 500);
      log.error('Unexpected error in chunk offset data handler', {
        message: error?.message,
        stack: error?.stack,
      });
      response.status(500).send('Internal server error');
    } finally {
      span.end();
    }
  });
};

export const createChunkPostHandler = ({
  arweaveClient,
  log,
}: {
  arweaveClient: ArweaveCompositeClient;
  log: Logger;
}) => {
  return asyncHandler(async (req: Request, res: Response) => {
    const span = tracer.startSpan('ChunkPostHandler.post', {
      attributes: {
        'chunk.size': req.body?.chunk ? req.body.chunk.length : 0,
        'http.method': 'POST',
        'http.target': req.originalUrl,
      },
    });

    try {
      // Extract the required headers
      const headers = {
        [headerNames.hops]: req.headers[headerNames.hops.toLowerCase()] as
          | string
          | undefined,
        [headerNames.origin]: req.headers[headerNames.origin.toLowerCase()] as
          | string
          | undefined,
      };

      // Broadcast the chunk using your system's Arweave client
      const result = await arweaveClient.broadcastChunk({
        chunk: req.body,
        abortTimeout: CHUNK_POST_ABORT_TIMEOUT_MS,
        responseTimeout: CHUNK_POST_RESPONSE_TIMEOUT_MS,
        chunkPostMinSuccessCount: CHUNK_POST_MIN_SUCCESS_COUNT,
        originAndHopsHeaders: headers,
        parentSpan: span,
      });

      // Check if successCount meets the threshold
      if (result.successCount >= CHUNK_POST_MIN_SUCCESS_COUNT) {
        span.setAttribute('chunk.broadcast.success', true);
        span.setAttribute('chunk.broadcast.success_count', result.successCount);
        span.setAttribute('chunk.broadcast.failure_count', result.failureCount);
        span.setAttribute('http.status_code', 200);
        res.status(200).send(result);
      } else {
        span.setAttribute('chunk.broadcast.success', false);
        span.setAttribute('chunk.broadcast.success_count', result.successCount);
        span.setAttribute('chunk.broadcast.failure_count', result.failureCount);
        span.setAttribute('http.status_code', 500);
        res.status(500).send(result);
      }
    } catch (error: any) {
      span.recordException(error);
      span.setAttribute('http.status_code', 500);
      log.error('Failed to broadcast chunk', {
        message: error?.message,
        stack: error?.stack,
      });
      res.status(500).send('Failed to broadcast chunk');
    } finally {
      span.end();
    }
  });
};
