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
import { toB64Url } from '../../lib/encoding.js';
import { Chunk, ChunkByAnySource, TxOffsetSource } from '../../types.js';
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

export const createChunkOffsetHandler = ({
  chunkSource,
  txOffsetSource,
  rateLimiter,
  paymentProcessor,
  log,
}: {
  chunkSource: ChunkByAnySource;
  txOffsetSource: TxOffsetSource;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  log: Logger;
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

      const finalDataRoot = data_root;
      const finalId = id;
      const finalDataSize = data_size;
      const finalWeaveOffset = weaveOffset;

      // Calculate the relative offset, needed for chunk data source
      const contiguousDataStartDelimiter = finalWeaveOffset - finalDataSize + 1;
      const relativeOffset = offset - contiguousDataStartDelimiter;

      span.setAttributes({
        'chunk.tx_id': finalId,
        'chunk.data_root': finalDataRoot,
        'chunk.data_size': finalDataSize,
        'chunk.weave_offset': finalWeaveOffset,
        'chunk.relative_offset': relativeOffset,
      });

      // composite-chunk-source returns chunk metadata and chunk data
      let chunk: Chunk | undefined = undefined;

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

export const createChunkOffsetDataHandler = ({
  chunkSource,
  txOffsetSource,
  rateLimiter,
  paymentProcessor,
  log,
}: {
  chunkSource: ChunkByAnySource;
  txOffsetSource: TxOffsetSource;
  rateLimiter?: RateLimiter;
  paymentProcessor?: PaymentProcessor;
  log: Logger;
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

      const finalDataRoot = data_root;
      const finalId = id;
      const finalDataSize = data_size;
      const finalWeaveOffset = weaveOffset;

      // Calculate the relative offset, needed for chunk data source
      const contiguousDataStartDelimiter = finalWeaveOffset - finalDataSize + 1;
      const relativeOffset = offset - contiguousDataStartDelimiter;

      span.setAttributes({
        'chunk.tx_id': finalId,
        'chunk.data_root': finalDataRoot,
        'chunk.data_size': finalDataSize,
        'chunk.weave_offset': finalWeaveOffset,
        'chunk.relative_offset': relativeOffset,
      });

      // composite-chunk-source returns chunk metadata and chunk data
      let chunk: Chunk | undefined = undefined;

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

      const { startOffset, endOffset, chunkSize } = parsed.boundaries;

      // Calculate absolute offsets in the weave
      const absoluteStartOffset = contiguousDataStartDelimiter + startOffset;
      const absoluteEndOffset = contiguousDataStartDelimiter + endOffset;

      // Calculate read offset within the returned chunk
      const readOffset = relativeOffset - startOffset;

      span.setAttributes({
        'chunk.start_offset': absoluteStartOffset,
        'chunk.end_offset': absoluteEndOffset,
        'chunk.tx_start_offset': startOffset,
        'chunk.tx_end_offset': endOffset,
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
      response.setHeader(headerNames.chunkTxId, finalId);
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
