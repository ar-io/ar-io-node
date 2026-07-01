/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import crypto from 'node:crypto';
import { Request, Response } from 'express';
import { default as asyncHandler } from 'express-async-handler';
import * as metrics from '../../metrics.js';
import {
  CHUNK_GET_BASE64_SIZE_BYTES,
  CHUNK_POST_ABORT_TIMEOUT_MS,
  CHUNK_POST_RESPONSE_TIMEOUT_MS,
  CHUNK_POST_MIN_SUCCESS_COUNT,
  CHUNK_POST_MIN_PREFERRED_SUCCESS_COUNT,
  CHUNK_SERVE_DEADLINE_MS,
  MAX_CHUNK_SIZE,
} from '../../config.js';
import * as config from '../../config.js';
import { headerNames } from '../../constants.js';
import { formatContentDigest } from '../../lib/digest.js';
import { toB64Url } from '../../lib/encoding.js';
import type {
  BroadcastChunkResponses,
  ChunkDataStore,
  ChunkMetadataStore,
  ChunkPlacementIndex,
} from '../../types.js';
import {
  ingestCacheOrigin,
  validateAndCacheIngestedChunk,
} from '../../data/ingest-chunk-cache.js';
import { ArweaveCompositeClient } from '../../arweave/composite-client.js';
import { Logger } from 'winston';
import { tracer, context, trace } from '../../tracing.js';
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
 * Thrown when a chunk serve exceeds {@link CHUNK_SERVE_DEADLINE_MS}. Classified
 * as a 404 by {@link classifyChunkRetrievalError}.
 */
export class ChunkServeTimeoutError extends Error {
  constructor(deadlineMs: number) {
    super(`Chunk serve exceeded ${deadlineMs}ms deadline`);
    this.name = 'ChunkServeTimeoutError';
  }
}

/**
 * Runs `op` under a wall-clock deadline.
 *
 * The retrieval cascade's per-source timeouts are additive with no overall
 * ceiling, and some awaited operations are abort-immune, so without this a
 * single serve can run until the upstream proxy cuts it at ~15s — a 504 that
 * also leaves the in-flight work running.
 *
 * On deadline this both (a) aborts `op` — so abort-honoring work stops promptly
 * — and (b) rejects with {@link ChunkServeTimeoutError}, so the handler can
 * respond even when the underlying work is abort-immune (that remainder
 * finishes detached from the response, bounded by the cascade's own timeouts).
 * The client's signal is merged in so a disconnect still cancels the work.
 *
 * A deadline of 0 disables the cap and threads the client signal through
 * unchanged.
 */
export function withChunkServeDeadline<T>(
  deadlineMs: number,
  clientSignal: AbortSignal | undefined,
  op: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (deadlineMs <= 0) {
    return op(clientSignal);
  }

  const deadline = new AbortController();
  const signal =
    clientSignal !== undefined
      ? AbortSignal.any([clientSignal, deadline.signal])
      : deadline.signal;

  let timer: ReturnType<typeof setTimeout>;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject BEFORE aborting. An abort-honoring `op` may reject its own
      // promise synchronously when the signal fires; rejecting the deadline
      // first guarantees the race settles as a ChunkServeTimeoutError (→ 404)
      // rather than the op's AbortError (which would misclassify as 502).
      reject(new ChunkServeTimeoutError(deadlineMs));
      deadline.abort();
    }, deadlineMs);
  });

  return Promise.race([op(signal), deadlinePromise]).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Classifies a failure thrown by {@link ChunkRetrievalService.retrieveChunk}
 * into the most accurate HTTP status.
 *
 * The chunk endpoints proxy a cascade of upstream sources (local cache → tx
 * boundary lookup → AR.IO peers → Arweave). A failure to obtain a chunk is
 * therefore an upstream/gateway condition, NOT an internal server error, and
 * must not be reported as a 500:
 *
 *   - client hung up mid-retrieval                    → 499 (Client Closed Request)
 *   - chunk not locatable / not retrievable in time   → 404 (Not Found)
 *   - upstreams reachable but served bad data         → 502 (Bad Gateway)
 *
 * Timeouts — both per-source timeouts and our own wall-clock serve deadline —
 * map to 404, matching the established contract: a chunk fetch that fails for
 * any reason is wrapped as ChunkNotFoundError → 404 (chunk-retrieval-service),
 * and the /raw first-data timeout likewise ends in a 404. Keeping the deadline
 * consistent (404, not 504) keeps these out of the 5xx count, lets the cascade
 * fall through to other sources, and lets nginx serve a fast cached 404 under
 * load. The real reason is preserved out-of-band in the span attribute and the
 * chunk_serve_deadline_exceeded_total metric, not in the HTTP status.
 *
 * Only genuinely unexpected errors (programming/encoding bugs surfaced by the
 * handler's outer try/catch) should remain 500s.
 */
export function classifyChunkRetrievalError(
  error: any,
  clientAborted: boolean,
): { statusCode: number; errorType: string } {
  // If the caller's own request signal is aborted, this is a client
  // disconnect — 499 — regardless of which error surfaced from the cascade.
  // (The cascade can mislabel a disconnect as a generic "all peers failed"
  // error; this is the backstop that keeps those out of the 5xx counts.)
  if (clientAborted) {
    return { statusCode: 499, errorType: 'client_disconnected' };
  }
  if (error instanceof ChunkNotFoundError) {
    return { statusCode: 404, errorType: error.errorType };
  }
  // Our own wall-clock cap on the whole serve fired. 404 (not 504) to match
  // the timeout-as-not-found contract; the reason lives in the metric/span.
  if (error instanceof ChunkServeTimeoutError) {
    return { statusCode: 404, errorType: 'serve_deadline_exceeded' };
  }
  // AbortSignal.timeout() rejects with a TimeoutError; the tx-chunks
  // first-data timeout carries 'timeout' in its message. Treated as
  // not-retrievable-in-time → 404, same as a wrapped ChunkNotFoundError.
  if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message ?? '')) {
    return { statusCode: 404, errorType: 'upstream_timeout' };
  }
  return { statusCode: 502, errorType: 'upstream_unavailable' };
}

/**
 * Applies a {@link classifyChunkRetrievalError} verdict to the response and
 * span. Logs at warn (not error) for upstream conditions so they stop reading
 * as server faults.
 */
function sendChunkRetrievalError(
  error: any,
  {
    request,
    response,
    span,
    log,
    offset,
  }: {
    request: Request;
    response: Response;
    span: ReturnType<typeof tracer.startSpan>;
    log: Logger;
    offset: number;
  },
): void {
  const { statusCode, errorType } = classifyChunkRetrievalError(
    error,
    request.signal?.aborted ?? false,
  );
  span.setAttribute('http.status_code', statusCode);
  span.setAttribute('chunk.retrieval.error', errorType);
  if (errorType === 'serve_deadline_exceeded') {
    metrics.chunkServeDeadlineExceededCounter.inc({ method: request.method });
  }
  if (statusCode >= 500) {
    span.recordException(error);
    log.warn('Unable to retrieve chunk from upstream sources', {
      offset,
      statusCode,
      errorType,
      message: error?.message,
    });
  }
  if (!response.headersSent) {
    if (statusCode === 404) {
      response.sendStatus(404);
    } else {
      response.status(statusCode).end();
    }
  }
}

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

    return context.with(trace.setSpan(context.active(), span), async () => {
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
          result = await withChunkServeDeadline(
            CHUNK_SERVE_DEADLINE_MS,
            request.signal,
            (signal) =>
              chunkRetrievalService.retrieveChunk(
                offset,
                requestAttributes,
                span,
                signal,
              ),
          );
        } catch (error: any) {
          // Retrieval failures are upstream/gateway conditions (or a client
          // disconnect), never a 500. See classifyChunkRetrievalError.
          sendChunkRetrievalError(error, {
            request,
            response,
            span,
            log,
            offset,
          });
          return;
        }

        const { chunk, dataRoot, dataSize, weaveOffset, relativeOffset } =
          result;

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
          span.setAttribute(
            'chunk.retrieval.error',
            'datapath_encoding_failed',
          );
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
            span.setAttribute(
              'chunk.retrieval.error',
              'txpath_encoding_failed',
            );
            span.recordException(error);
            log.error('Error getting tx path from chunk', { error });
            response.status(500).send('Error converting tx path to base64url');
            return;
          }
        }

        // Set common headers (source tracking, cache status). The hashString
        // returned here is the hash of the raw chunk BYTES — not the JSON
        // wrapper served by this endpoint. We deliberately do NOT use it for
        // ETag here because ETag must describe the served representation
        // (RFC 9110 §8.8.1), and what's served is the JSON wrapper. The
        // raw-chunk hash still lives in X-AR-IO-Hash via setCommonChunkHeaders
        // for clients that need to identify the underlying chunk bytes.
        setCommonChunkHeaders(response, chunk, span);

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

        // Bind the JSON body to the HTTPSIG signature: hash the serialized
        // response (NOT the raw chunk bytes — those are wrapped in JSON here)
        // and emit Content-Digest (in CO_SIGNABLE_HEADERS) plus X-AR-IO-Digest
        // and ETag, all derived from the same JSON-body hash so the
        // representation, the digest, and the cache validator agree. JSON is
        // fully in memory so this is unconditional and free — no threshold,
        // no buffering tradeoffs.
        const jsonDigestB64Url = crypto
          .createHash('sha256')
          .update(responseBodyString)
          .digest('base64url');
        // Note: chunk responses deliberately do NOT emit X-AR-IO-Digest.
        // That legacy header carries the raw-chunk hash on the data path
        // for Wayfinder backwards-compat, which doesn't apply here. The
        // standards-track Content-Digest is what carries the body binding.
        setChunkETag(response, jsonDigestB64Url);
        response.setHeader(
          headerNames.contentDigest,
          formatContentDigest(jsonDigestB64Url),
        );
        metrics.incHttpSigContentDigest({
          source: 'computed_buffered',
          path: 'chunk',
        });

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

    return context.with(trace.setSpan(context.active(), span), async () => {
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
          result = await withChunkServeDeadline(
            CHUNK_SERVE_DEADLINE_MS,
            request.signal,
            (signal) =>
              chunkRetrievalService.retrieveChunk(
                offset,
                requestAttributes,
                span,
                signal,
              ),
          );
        } catch (error: any) {
          // Retrieval failures are upstream/gateway conditions (or a client
          // disconnect), never a 500. See classifyChunkRetrievalError.
          sendChunkRetrievalError(error, {
            request,
            response,
            span,
            log,
            offset,
          });
          return;
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
          // The data_path was served by an upstream chunk source; if it won't
          // parse/validate, that's bad upstream data (502), not a fault in
          // this gateway (500).
          span.setAttribute('http.status_code', 502);
          span.setAttribute(
            'chunk.retrieval.error',
            'merkle_path_parse_failed',
          );
          span.recordException(error);
          log.warn('Error parsing merkle path from upstream chunk', { error });
          response.status(502).send('Error parsing merkle path');
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
        response.setHeader(
          headerNames.chunkDataPath,
          toB64Url(chunk.data_path),
        );
        response.setHeader(
          headerNames.chunkDataRoot,
          toB64Url(chunk.data_root),
        );
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

        // Set ETag and Content-Digest. Cache hits / HEAD requests use the
        // already-known hashString. Uncached chunks compute the digest from
        // the in-memory chunk bytes — chunks are bounded at 256 KiB so this
        // is always cheap (~50 µs SHA-256). Result: every served chunk
        // carries a body-bound digest, so the HTTPSIG signature pins the
        // bytes end-to-end. See architect-handoff/httpsig-body-binding-plan.md.
        let digestB64Url: string | undefined = hashString;
        if (digestB64Url !== undefined) {
          metrics.incHttpSigContentDigest({
            source: 'cache_hit',
            path: 'chunk',
          });
        } else if (chunk.chunk !== undefined && chunk.chunk.length > 0) {
          digestB64Url = crypto
            .createHash('sha256')
            .update(chunk.chunk)
            .digest('base64url');
          metrics.incHttpSigContentDigest({
            source: 'computed_buffered',
            path: 'chunk',
          });
        }

        if (digestB64Url !== undefined) {
          // Note: chunk responses deliberately do NOT emit X-AR-IO-Digest.
          // Content-Digest (standards-track, signed) is what carries the
          // body binding here.
          setChunkETag(response, digestB64Url);
          response.setHeader(
            headerNames.contentDigest,
            formatContentDigest(digestB64Url),
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
  });
};

/**
 * Determines the appropriate HTTP status code to return to the client
 * when a chunk broadcast has failed (successCount < threshold).
 *
 * - Excludes skipped peers (they were never contacted)
 * - Excludes successful peers (we only aggregate errors for the failure response)
 * - Maps special cases: canceled → 499, timeout → 504, network error → 502
 * - Returns the most common error status code among failed peers
 * - Tie-breaker: prefers lowest 4xx, then lowest 5xx
 */
export function determineFailureStatusCode(
  results: BroadcastChunkResponses[],
): number {
  // Filter out skipped peers and successful posts - we only care about failures
  const failedResults = results.filter((r) => !r.skipped && !r.success);

  if (failedResults.length === 0) {
    return 500; // No failed peers to aggregate
  }

  // Count status codes, mapping special cases
  const statusCounts = new Map<number, number>();

  for (const result of failedResults) {
    let statusCode: number;
    if (result.canceled) {
      statusCode = 499; // Client Closed Request
    } else if (result.timedOut) {
      statusCode = 504; // Gateway Timeout
    } else if (result.statusCode === 0 || result.statusCode === undefined) {
      statusCode = 502; // Bad Gateway (network error)
    } else {
      statusCode = result.statusCode;
    }
    statusCounts.set(statusCode, (statusCounts.get(statusCode) ?? 0) + 1);
  }

  // Find most common status code with tie-breaker rules
  let maxCount = 0;
  let selectedCode = 500;

  for (const [code, count] of statusCounts) {
    if (count > maxCount) {
      maxCount = count;
      selectedCode = code;
    } else if (count === maxCount) {
      // Tie-breaker: prefer 4xx over 5xx, then lowest value
      const selected4xx = selectedCode >= 400 && selectedCode < 500;
      const current4xx = code >= 400 && code < 500;
      if (current4xx && !selected4xx) {
        selectedCode = code;
      } else if (current4xx === selected4xx && code < selectedCode) {
        selectedCode = code;
      }
    }
  }

  return selectedCode;
}

/**
 * Creates a handler for chunk posting (POST /chunk).
 */
export const createChunkPostHandler = ({
  arweaveClient,
  chunkDataStore,
  chunkMetadataStore,
  chunkPlacementIndex,
  log,
}: {
  arweaveClient: ArweaveCompositeClient;
  chunkDataStore: ChunkDataStore;
  chunkMetadataStore: ChunkMetadataStore;
  chunkPlacementIndex: ChunkPlacementIndex;
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

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        // Extract the required headers
        const headers = {
          [headerNames.hops]: req.headers[headerNames.hops.toLowerCase()] as
            | string
            | undefined,
          [headerNames.origin]: req.headers[
            headerNames.origin.toLowerCase()
          ] as string | undefined,
          [headerNames.via]: req.headers[headerNames.via.toLowerCase()] as
            | string
            | undefined,
        };

        // Broadcast the chunk using your system's Arweave client
        const result = await arweaveClient.broadcastChunk({
          chunk: req.body,
          abortTimeout: CHUNK_POST_ABORT_TIMEOUT_MS,
          responseTimeout: CHUNK_POST_RESPONSE_TIMEOUT_MS,
          chunkPostMinSuccessCount: CHUNK_POST_MIN_SUCCESS_COUNT,
          chunkPostMinPreferredSuccessCount:
            CHUNK_POST_MIN_PREFERRED_SUCCESS_COUNT,
          originAndHopsHeaders: headers,
          parentSpan: span,
        });

        // The broadcaster owns the quorum verdict (success/preferred/distinct-
        // domain + soft-preferred fallback) — read it, don't recompute it here.
        const meetsSuccessThreshold = result.succeeded;
        span.setAttributes({
          'chunk.broadcast.success': meetsSuccessThreshold,
          'chunk.broadcast.success_count': result.successCount,
          'chunk.broadcast.preferred_success_count':
            result.preferredSuccessCount,
          'chunk.broadcast.distinct_domains': result.distinctDomainCount,
          'chunk.broadcast.failure_count': result.failureCount,
        });

        // Placement-evidence contract: surface the distinct-fault-domain count
        // so a caller (the bundler) can read where the chunk landed without
        // parsing the body. The full result is also returned in the body below.
        res.setHeader(
          headerNames.chunkPlacementDomains,
          String(result.distinctDomainCount),
        );

        if (meetsSuccessThreshold) {
          span.setAttribute('http.status_code', 200);
          res.status(200).send(result);
        } else {
          const failureStatusCode = determineFailureStatusCode(result.results);
          span.setAttribute(
            'chunk.broadcast.failure_status_code',
            failureStatusCode,
          );
          span.setAttribute('http.status_code', failureStatusCode);
          res.status(failureStatusCode).send(result);
        }

        // Optimistic ingest caching: fire-and-forget after the response is
        // queued so it never adds latency to the broadcast. Gated by
        // ingestCacheOrigin (enabled + allowlist). A chunk under a data_root
        // that never confirms on-chain is unaddressable and is reclaimed by the
        // GC sweep, so open ingest cannot poison or be served wrong bytes.
        if (config.CHUNK_INGEST_CACHE_ENABLED) {
          const ingestOrigin = ingestCacheOrigin(req);
          if (ingestOrigin !== null) {
            void validateAndCacheIngestedChunk({
              chunkDataStore,
              chunkMetadataStore,
              chunkPlacementIndex,
              body: req.body,
              origin: ingestOrigin,
              log,
            }).catch((cacheError: any) => {
              log.warn('Optimistic chunk caching failed', {
                message: cacheError?.message,
              });
            });
          } else {
            // Enabled but poster not allowlisted — make gated posts observable.
            metrics.chunkIngestCacheCounter.inc({
              result: 'skipped_not_allowlisted',
            });
          }
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
  });
};
