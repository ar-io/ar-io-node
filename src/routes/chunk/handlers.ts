/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import { StandaloneSqliteDatabase } from '../../database/standalone-sqlite.js';
import {
  CHUNK_POST_ABORT_TIMEOUT_MS,
  CHUNK_POST_RESPONSE_TIMEOUT_MS,
  CHUNK_POST_MIN_SUCCESS_COUNT,
} from '../../config.js';
import * as config from '../../config.js';
import { headerNames } from '../../constants.js';
import { toB64Url } from '../../lib/encoding.js';
import { Chunk, ChunkByAnySource } from '../../types.js';
import { ArweaveCompositeClient } from '../../arweave/composite-client.js';
import { Logger } from 'winston';
import { tracer } from '../../tracing.js';
import { getRequestAttributes } from '../data/handlers.js';

const handleIfNoneMatch = (req: Request, res: Response): boolean => {
  const ifNoneMatch = req.get('if-none-match');
  const etag = res.getHeader('etag');

  if (ifNoneMatch !== undefined && etag !== undefined && ifNoneMatch === etag) {
    res.status(304);
    // Remove entity headers as per RFC 7232
    res.removeHeader('content-length');
    res.removeHeader('content-type');
    return true;
  }
  return false;
};

export const createChunkOffsetHandler = ({
  chunkSource,
  db,
  log,
  arweaveClient,
}: {
  chunkSource: ChunkByAnySource;
  db: StandaloneSqliteDatabase;
  log: Logger;
  arweaveClient?: ArweaveCompositeClient;
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

      // Try to get transaction info from database first
      let dbResult;
      let usedFallback = false;

      try {
        dbResult = await db.getTxByOffset(offset);
      } catch (error) {
        log.debug('Database lookup failed, no fallback will be attempted', {
          offset,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        span.setAttribute('http.status_code', 404);
        span.setAttribute('chunk.retrieval.error', 'db_lookup_failed');
        response.sendStatus(404);
        return;
      }

      const { data_root, id, data_size, offset: weaveOffset } = dbResult;

      // Check if database returned empty/invalid result and fallback is available
      if (
        (data_root === undefined ||
          weaveOffset === undefined ||
          id === undefined ||
          data_size === undefined) &&
        arweaveClient &&
        config.CHUNK_OFFSET_CHAIN_FALLBACK_ENABLED
      ) {
        span.addEvent(
          'Database returned empty result, attempting chain fallback',
        );
        log.debug('Database returned empty result, attempting chain fallback', {
          offset,
        });

        try {
          const chainResult = await arweaveClient.findTxByOffset(offset);
          if (chainResult) {
            // Get transaction details from chain
            const tx = await arweaveClient.getTx({ txId: chainResult.txId });
            if (
              tx !== undefined &&
              tx !== null &&
              tx.data_root !== undefined &&
              tx.data_size !== undefined
            ) {
              // Reconstruct the dbResult-like object from chain data
              Object.assign(dbResult, {
                data_root: tx.data_root,
                id: chainResult.txId,
                data_size: parseInt(tx.data_size),
                offset: chainResult.txOffset,
              });
              usedFallback = true;
              span.addEvent('Chain fallback successful');
              span.setAttribute('chunk.used_chain_fallback', true);
              log.debug('Chain fallback successful', {
                offset,
                txId: chainResult.txId,
                txOffset: chainResult.txOffset,
              });
            } else {
              throw new Error('Invalid transaction data from chain');
            }
          } else {
            throw new Error('Transaction not found on chain');
          }
        } catch (error: any) {
          span.setAttribute('http.status_code', 404);
          span.setAttribute('chunk.retrieval.error', 'chain_fallback_failed');
          span.addEvent('Chain fallback failed');
          log.debug('Chain fallback failed', {
            offset,
            error: error.message,
          });
          response.sendStatus(404);
          return;
        }
      } else if (
        data_root === undefined ||
        weaveOffset === undefined ||
        id === undefined ||
        data_size === undefined
      ) {
        // No fallback available and database result is invalid
        span.setAttribute('http.status_code', 404);
        span.setAttribute('chunk.retrieval.error', 'tx_not_found');
        span.addEvent(
          'Transaction not found in database and no fallback available',
        );
        response.sendStatus(404);
        return;
      }

      // Re-extract the values in case they were updated by fallback
      const finalDataRoot = dbResult.data_root;
      const finalId = dbResult.id;
      const finalDataSize = dbResult.data_size;
      const finalWeaveOffset = dbResult.offset;

      // Calculate the relative offset, needed for chunk data source
      const contiguousDataStartDelimiter = finalWeaveOffset - finalDataSize + 1;
      const relativeOffset = offset - contiguousDataStartDelimiter;

      span.setAttributes({
        'chunk.tx_id': finalId,
        'chunk.data_root': finalDataRoot,
        'chunk.data_size': finalDataSize,
        'chunk.weave_offset': finalWeaveOffset,
        'chunk.relative_offset': relativeOffset,
        'chunk.used_fallback': usedFallback,
      });

      // Extract request attributes for hop tracking
      const requestAttributes = getRequestAttributes(request, response);

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
