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
}: {
  chunkSource: ChunkByAnySource;
  db: StandaloneSqliteDatabase;
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

      // TODO: use a binary search to get this from the chain if it's not
      // available in the DB
      const {
        data_root,
        id,
        data_size,
        offset: weaveOffset,
      } = await db.getTxByOffset(offset);

      // This is unnecessary amount of validation, but it is here to be make typescript happy
      if (
        data_root === undefined ||
        weaveOffset === undefined ||
        id === undefined ||
        data_size === undefined
      ) {
        span.setAttribute('http.status_code', 404);
        span.setAttribute('chunk.retrieval.error', 'tx_not_found');
        span.addEvent('Transaction not found in database');
        response.sendStatus(404);
        return;
      }

      // Calculate the relative offset, needed for chunk data source
      const contiguousDataStartDelimiter = weaveOffset - data_size + 1;
      const relativeOffset = offset - contiguousDataStartDelimiter;

      span.setAttributes({
        'chunk.tx_id': id,
        'chunk.data_root': data_root,
        'chunk.data_size': data_size,
        'chunk.weave_offset': weaveOffset,
        'chunk.relative_offset': relativeOffset,
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
          txSize: data_size,
          absoluteOffset: offset,
          dataRoot: data_root,
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
        response.setHeader(headerNames.chunkSource, chunk.source);
      }
      if (chunk.sourceHost !== undefined && chunk.sourceHost !== '') {
        response.setHeader(headerNames.chunkHost, chunk.sourceHost);
      }

      // Set cache status header
      const cacheStatus = chunk.source === 'cache' ? 'HIT' : 'MISS';
      response.setHeader(headerNames.cache, cacheStatus);
      span.setAttribute('chunk.cache_status', cacheStatus);

      // Add ETag and digest headers when hash is available
      // Following the pattern from data handlers: only add these when
      // data is cached OR it's a HEAD request (to prevent incorrect hashes on streamed data)
      if (
        chunk.hash !== undefined &&
        (chunk.source === 'cache' || request.method === 'HEAD')
      ) {
        const hashString = toB64Url(chunk.hash);
        response.setHeader('ETag', `"${hashString}"`);
        response.setHeader(headerNames.digest, hashString);
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
