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
import {
  ChunkRetrievalService,
  ChunkNotFoundError,
  hasTxId,
} from '../../data/chunk-retrieval-service.js';
import { setCommonChunkHeaders, setChunkETag } from './response-utils.js';

/**
 * Creates a handler for the chunk offset endpoint (GET/HEAD /chunk/:offset).
 *
 * Returns chunk data in JSON format with base64url encoding.
 */
export const createChunkOffsetHandler = ({
  chunkRetrievalService,
  rateLimiter,
  paymentProcessor,
  log,
}: {
  chunkRetrievalService: ChunkRetrievalService;
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
      if (rateLimiter !== undefined || paymentProcessor !== undefined) {
        const contentSize =
          request.method === 'HEAD' ? 0 : CHUNK_GET_BASE64_SIZE_BYTES;

        const limitCheck = await checkPaymentAndRateLimits({
          req: request,
          res: response,
          contentSize,
          contentType: undefined,
          requestAttributes,
          rateLimiter,
          paymentProcessor,
          parentSpan: span,
          browserPaymentFlow: 'direct',
        });

        if (!limitCheck.allowed) {
          return;
        }

        // Schedule token adjustment based on actual response size
        if (rateLimiter && limitCheck.ipTokensConsumed !== undefined) {
          response.on('finish', () => {
            let actualSize = 0;
            if (response.statusCode === 304 || request.method === 'HEAD') {
              actualSize = 0;
            } else if (response.statusCode === 200) {
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

      // === RETRIEVE CHUNK VIA SERVICE ===
      let result;
      try {
        result = await chunkRetrievalService.retrieveChunk(
          offset,
          requestAttributes,
          span,
        );
      } catch (error: any) {
        if (error instanceof ChunkNotFoundError) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('chunk.retrieval.error', error.errorType);
          response.sendStatus(404);
          return;
        }
        throw error;
      }

      const { chunk, dataRoot, dataSize, weaveOffset, relativeOffset } = result;

      // Set span attributes based on result type
      span.setAttribute('chunk.retrieval_path', result.type);
      span.setAttribute('chunk.data_root', dataRoot);
      span.setAttribute('chunk.data_size', dataSize);
      span.setAttribute('chunk.weave_offset', weaveOffset);
      span.setAttribute('chunk.relative_offset', relativeOffset);

      if (hasTxId(result)) {
        span.setAttribute('chunk.tx_id', result.txId);
      }

      // === PREPARE RESPONSE ===
      let chunkBase64Url: string;
      let dataPath: string;

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

      let txPath: string | undefined;
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

      // Set common headers (source tracking, cache status)
      const { hashString } = setCommonChunkHeaders(response, chunk, span);

      // Set ETag when hash is available (cache hits or HEAD requests)
      if (
        hashString !== undefined &&
        (chunk.source === 'cache' || request.method === 'HEAD')
      ) {
        setChunkETag(response, hashString);
      }

      // Set content type and prepare response
      response.setHeader('Content-Type', 'application/json; charset=utf-8');

      const responseBody = {
        chunk: chunkBase64Url,
        ...(dataPath !== undefined && { data_path: dataPath }),
        ...(txPath !== undefined && { tx_path: txPath }),
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

      // Handle HEAD request
      if (request.method === 'HEAD') {
        span.addEvent('HEAD request - headers only');
        response.status(200).end();
        return;
      }

      span.addEvent('Chunk response successful');
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
 * Returns chunk data in raw binary format (application/octet-stream) with metadata in headers.
 */
export const createChunkOffsetDataHandler = ({
  chunkRetrievalService,
  rateLimiter,
  paymentProcessor,
  log,
}: {
  chunkRetrievalService: ChunkRetrievalService;
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
      if (rateLimiter !== undefined || paymentProcessor !== undefined) {
        const contentSize = request.method === 'HEAD' ? 0 : MAX_CHUNK_SIZE;

        const limitCheck = await checkPaymentAndRateLimits({
          req: request,
          res: response,
          contentSize,
          contentType: undefined,
          requestAttributes,
          rateLimiter,
          paymentProcessor,
          parentSpan: span,
          browserPaymentFlow: 'direct',
        });

        if (!limitCheck.allowed) {
          return;
        }

        // Schedule token adjustment based on actual response size
        if (rateLimiter && limitCheck.ipTokensConsumed !== undefined) {
          response.on('finish', () => {
            let actualSize = 0;
            if (response.statusCode === 304 || request.method === 'HEAD') {
              actualSize = 0;
            } else if (response.statusCode === 200) {
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

      // === RETRIEVE CHUNK VIA SERVICE ===
      let result;
      try {
        result = await chunkRetrievalService.retrieveChunk(
          offset,
          requestAttributes,
          span,
        );
      } catch (error: any) {
        if (error instanceof ChunkNotFoundError) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('chunk.retrieval.error', error.errorType);
          response.sendStatus(404);
          return;
        }
        throw error;
      }

      const {
        chunk,
        dataRoot,
        dataSize,
        relativeOffset,
        contiguousDataStartDelimiter,
      } = result;

      // Set span attributes based on result type
      span.setAttribute('chunk.retrieval_path', result.type);
      span.setAttribute('chunk.data_root', dataRoot);
      span.setAttribute('chunk.data_size', dataSize);
      span.setAttribute('chunk.relative_offset', relativeOffset);

      if (hasTxId(result)) {
        span.setAttribute('chunk.tx_id', result.txId);
      }

      // Parse merkle path to extract chunk boundaries
      let parsed;
      try {
        parsed = await parseDataPath({
          dataRoot: Buffer.from(dataRoot, 'base64url'),
          dataSize: dataSize,
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
      const readOffset = relativeOffset - startOffset;

      span.setAttributes({
        'chunk.start_offset': absoluteStartOffset,
        'chunk.tx_start_offset': startOffset,
        'chunk.read_offset': readOffset,
        'chunk.size': chunkSize,
      });

      // === SET RESPONSE HEADERS ===
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', chunk.chunk.length.toString());

      // Chunk metadata headers
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
      response.setHeader(headerNames.chunkTxDataSize, dataSize.toString());

      // TX ID header (only for fallback path results)
      if (hasTxId(result)) {
        response.setHeader(headerNames.chunkTxId, result.txId);
      }

      response.setHeader(
        headerNames.chunkTxStartOffset,
        contiguousDataStartDelimiter.toString(),
      );

      // tx_path header
      if (chunk.tx_path !== undefined) {
        response.setHeader(headerNames.chunkTxPath, toB64Url(chunk.tx_path));
      } else {
        response.setHeader(headerNames.chunkTxPath, '');
      }

      // Set common headers (source tracking, cache status)
      const { hashString } = setCommonChunkHeaders(response, chunk, span);

      // Set ETag and Content-Digest when hash is available (cache hits or HEAD requests)
      if (
        hashString !== undefined &&
        (chunk.source === 'cache' || request.method === 'HEAD')
      ) {
        setChunkETag(response, hashString);
        response.setHeader(
          headerNames.contentDigest,
          formatContentDigest(hashString),
        );
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

      // Handle HEAD request
      if (request.method === 'HEAD') {
        span.addEvent('HEAD request - headers only');
        response.status(200).end();
        return;
      }

      span.addEvent('Chunk response successful');
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

/**
 * Creates a handler for chunk posting (POST /chunk).
 */
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
