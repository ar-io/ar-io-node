/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';
import { anySignal, ClearableSignal } from 'any-signal';
import { LRUCache } from 'lru-cache';
import pLimit, { LimitFunction } from 'p-limit';
import winston from 'winston';
import { MAX_CHUNK_SIZE } from '../config.js';
import { generateRequestAttributes } from '../lib/request-attributes.js';
import { streamRangeData } from '../lib/stream-tx-range.js';
import { startChildSpan } from '../tracing.js';
import { SpanStatusCode, Span } from '@opentelemetry/api';

import {
  ChainSource,
  ChunkData,
  ChunkDataByAnySource,
  ChunkByAnySource,
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
  TxGeometry,
  TxGeometrySource,
} from '../types.js';
import * as metrics from '../metrics.js';

type GeometrySourceName = 'cache' | 'db' | 'chain';

interface ResolvedGeometry {
  geometry: TxGeometry;
  source: GeometrySourceName;
}

// How long a chain re-check that confirmed local geometry suppresses further
// re-checks for the same transaction. Stable geometry is immutable, so this
// only bounds trusted-node spend on transactions whose chunks keep failing.
const GEOMETRY_VERIFIED_TTL_MS = 60 * 60 * 1000;

function sameGeometry(a: TxGeometry, b: TxGeometry): boolean {
  return (
    a.dataRoot === b.dataRoot && a.offset === b.offset && a.size === b.size
  );
}

export class TxChunksDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private chainSource: ChainSource;
  private chunkSource: ChunkDataByAnySource & ChunkByAnySource;
  private concurrencyLimit: LimitFunction;
  private firstDataTimeoutMs: number;
  private txGeometrySource?: TxGeometrySource;
  private geometryCache: LRUCache<string, TxGeometry>;
  private geometryVerified: LRUCache<string, true>;
  // Chain geometry for transactions whose local geometry disagreed with the
  // chain. Consulted before the local index so a bad row costs at most one
  // failed read and one chain re-check per GEOMETRY_VERIFIED_TTL_MS.
  private geometryOverrides: LRUCache<string, TxGeometry>;
  // Errors from reads that used locally resolved geometry, so getData can
  // re-check that geometry against the chain before giving up.
  private localGeometryErrors = new WeakMap<object, TxGeometry>();

  constructor({
    log,
    chainSource,
    chunkSource,
    concurrencyLimit,
    firstDataTimeoutMs = 0,
    txGeometrySource,
    geometryCacheSize = 10000,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    chunkSource: ChunkDataByAnySource & ChunkByAnySource;
    concurrencyLimit?: LimitFunction;
    firstDataTimeoutMs?: number;
    txGeometrySource?: TxGeometrySource;
    geometryCacheSize?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
    this.concurrencyLimit = concurrencyLimit ?? pLimit(Infinity);
    this.firstDataTimeoutMs = firstDataTimeoutMs;
    this.txGeometrySource = txGeometrySource;
    this.geometryCache = new LRUCache({ max: geometryCacheSize });
    this.geometryVerified = new LRUCache({
      max: geometryCacheSize,
      ttl: GEOMETRY_VERIFIED_TTL_MS,
    });
    this.geometryOverrides = new LRUCache({
      max: geometryCacheSize,
      ttl: GEOMETRY_VERIFIED_TTL_MS,
    });
  }

  /**
   * Resolve geometry from the in-memory cache, then the local stable
   * transactions index, then the chain. Local results are cached; chain
   * results are not, since they may describe a transaction that is not yet
   * stable.
   */
  private async resolveGeometry(
    id: string,
    signal?: AbortSignal,
  ): Promise<ResolvedGeometry> {
    const override = this.geometryOverrides.get(id);
    if (override !== undefined) {
      metrics.txChunksGeometryLookupTotal.inc({
        source: 'override',
        outcome: 'hit',
      });
      // Reported as chain geometry: it came from the chain, so a failing read
      // with it is not re-verified.
      return { geometry: override, source: 'chain' };
    }

    const cached = this.geometryCache.get(id);
    if (cached !== undefined) {
      metrics.txChunksGeometryLookupTotal.inc({
        source: 'cache',
        outcome: 'hit',
      });
      return { geometry: cached, source: 'cache' };
    }

    if (this.txGeometrySource !== undefined) {
      signal?.throwIfAborted();
      try {
        const geometry = await this.txGeometrySource.getTxGeometry(id);
        if (
          geometry !== undefined &&
          Number.isSafeInteger(geometry.offset) &&
          Number.isSafeInteger(geometry.size) &&
          geometry.size > 0
        ) {
          metrics.txChunksGeometryLookupTotal.inc({
            source: 'db',
            outcome: 'hit',
          });
          this.geometryCache.set(id, geometry);
          return { geometry, source: 'db' };
        }
        metrics.txChunksGeometryLookupTotal.inc({
          source: 'db',
          outcome: 'miss',
        });
      } catch (error: any) {
        metrics.txChunksGeometryLookupTotal.inc({
          source: 'db',
          outcome: 'error',
        });
        this.log.debug('Local tx geometry lookup failed, using chain', {
          id,
          error: error?.message,
        });
      }
    }

    return {
      geometry: await this.getChainGeometry(id, signal),
      source: 'chain',
    };
  }

  private async getChainGeometry(
    id: string,
    signal?: AbortSignal,
  ): Promise<TxGeometry> {
    try {
      const [dataRoot, txOffset] = await Promise.all([
        this.chainSource.getTxField(id, 'data_root', signal),
        this.chainSource.getTxOffset(id, signal),
      ]);
      metrics.txChunksGeometryLookupTotal.inc({
        source: 'chain',
        outcome: 'hit',
      });
      return { dataRoot, offset: +txOffset.offset, size: +txOffset.size };
    } catch (error: any) {
      // A caller cancellation (AbortError, or axios CanceledError) is not a
      // chain lookup failure.
      if (!signal?.aborted && error?.name !== 'AbortError') {
        metrics.txChunksGeometryLookupTotal.inc({
          source: 'chain',
          outcome: 'error',
        });
      }
      throw error;
    }
  }

  /**
   * Create an AbortController that fires after firstDataTimeoutMs, or null if
   * the timeout is disabled. When the timeout fires, the metric is incremented
   * and the controller is aborted. Callers must invoke cleanup() to clear the
   * timer once the first data arrives (or the request fails).
   */
  private createFirstDataTimeoutController(requestType: string): {
    signal: AbortSignal;
    cleanup: () => void;
  } | null {
    if (this.firstDataTimeoutMs <= 0) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      metrics.chunkFirstDataTimeoutsTotal.inc({
        request_type: requestType,
      });
      controller.abort();
    }, this.firstDataTimeoutMs);

    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timeoutId),
    };
  }

  async getData(args: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
    signal?: AbortSignal;
  }): Promise<ContiguousData> {
    try {
      return await this.getDataWithGeometry(args);
    } catch (error: any) {
      const localGeometry =
        error !== null && typeof error === 'object'
          ? this.localGeometryErrors.get(error)
          : undefined;
      if (localGeometry === undefined || args.signal?.aborted) {
        throw error;
      }
      this.localGeometryErrors.delete(error);

      // A read using local geometry failed before its first byte. Only a
      // disagreement with the chain justifies a second attempt, so chunks that
      // are genuinely unavailable don't cost a duplicate peer cascade. Each
      // transaction is re-checked at most once per GEOMETRY_VERIFIED_TTL_MS.
      if (this.geometryVerified.has(args.id)) {
        metrics.txChunksGeometryVerifyTotal.inc({ result: 'skipped' });
        throw error;
      }

      let chainGeometry: TxGeometry;
      try {
        chainGeometry = await this.getChainGeometry(args.id, args.signal);
      } catch (chainError: any) {
        // Cancellation surfaces as an AbortError or an axios CanceledError, so
        // key off the caller's signal rather than the error type.
        if (args.signal?.aborted || chainError?.name === 'AbortError') {
          throw chainError;
        }
        metrics.txChunksGeometryVerifyTotal.inc({ result: 'chain_error' });
        throw error;
      }

      if (sameGeometry(localGeometry, chainGeometry)) {
        metrics.txChunksGeometryVerifyTotal.inc({ result: 'match' });
        this.geometryVerified.set(args.id, true);
        throw error;
      }

      metrics.txChunksGeometryVerifyTotal.inc({ result: 'mismatch' });
      this.log.warn(
        'Local tx geometry disagrees with chain; retrying with chain geometry',
        { id: args.id, local: localGeometry, chain: chainGeometry },
      );
      this.geometryCache.delete(args.id);
      this.geometryOverrides.set(args.id, chainGeometry);
      return this.getDataWithGeometry(args, chainGeometry);
    }
  }

  private async getDataWithGeometry(
    {
      id,
      requestAttributes,
      region,
      parentSpan,
      signal,
    }: {
      id: string;
      requestAttributes?: RequestAttributes;
      region?: Region;
      parentSpan?: Span;
      signal?: AbortSignal;
    },
    chainGeometry?: TxGeometry,
  ): Promise<ContiguousData> {
    const span = startChildSpan(
      'TxChunksDataSource.getData',
      {
        attributes: {
          'data.id': id,
          'data.region.has_region': region !== undefined,
          'data.region.offset': region?.offset,
          'data.region.size': region?.size,
          'arns.name': requestAttributes?.arnsName,
          'arns.basename': requestAttributes?.arnsBasename,
        },
      },
      parentSpan,
    );

    let timeout: ReturnType<typeof this.createFirstDataTimeoutController> =
      null;
    let combinedSignal: ClearableSignal | undefined;
    let resolved: ResolvedGeometry | undefined;

    try {
      // Check for abort before starting
      signal?.throwIfAborted();

      this.log.debug('Fetching chunk data for TX', { id });

      span.addEvent('Resolving tx geometry');
      // Pass caller's signal directly (not effectiveSignal — that's
      // constructed below from caller's signal + first-data timeout, and the
      // first-data timer should only start after geometry resolves).
      resolved =
        chainGeometry !== undefined
          ? { geometry: chainGeometry, source: 'chain' }
          : await this.resolveGeometry(id, signal);
      const txDataRoot = resolved.geometry.dataRoot;
      const size = resolved.geometry.size;
      const offset = resolved.geometry.offset;
      const startOffset = offset - size + 1;
      let bytes = 0;

      // Combine caller signal and first-data timeout into a single signal
      const requestType = region ? 'range' : 'full';
      timeout = this.createFirstDataTimeoutController(requestType);
      let effectiveSignal: AbortSignal | undefined;
      if (timeout?.signal && signal) {
        combinedSignal = anySignal([timeout.signal, signal]);
        effectiveSignal = combinedSignal;
      } else {
        effectiveSignal = timeout?.signal ?? signal;
      }

      span.setAttributes({
        'chunks.tx.data_root': txDataRoot,
        'chunks.tx.size': size,
        'chunks.tx.offset': offset,
        'chunks.tx.start_offset': startOffset,
        'chunks.tx.geometry_source': resolved.source,
      });

      span.addEvent('Tx geometry resolved');

      if (region) {
        span.setAttribute('chunks.streaming.request_type', 'range');
        span.addEvent('Starting range streaming');

        const getChunkByAny = (params: {
          txSize: number;
          absoluteOffset: number;
          dataRoot: string;
          relativeOffset: number;
        }) =>
          this.concurrencyLimit(() =>
            this.chunkSource.getChunkByAny(params, effectiveSignal),
          );

        // Use efficient range streaming that seeks directly to required chunks
        const rangeStartTime = Date.now();
        const rangeResult = streamRangeData({
          txId: id,
          txSize: size,
          txAbsoluteStart: startOffset,
          dataRoot: txDataRoot,
          rangeStart: region.offset,
          rangeEnd: region.offset + region.size,
          getChunkByAny,
          log: this.log,
          signal: effectiveSignal,
        });

        // Eagerly pull the first value to detect failures/timeouts early
        const rangeIterator = rangeResult.stream[Symbol.asyncIterator]();
        let firstResult: IteratorResult<Buffer>;
        try {
          firstResult = await rangeIterator.next();
          timeout?.cleanup();
        } catch (error: any) {
          timeout?.cleanup();
          if (timeout?.signal.aborted) {
            throw new Error(
              `First chunk data timeout after ${this.firstDataTimeoutMs}ms`,
            );
          }
          throw error;
        }

        // Prepend the first value back and continue with the rest
        async function* prependFirst() {
          if (!firstResult.done) {
            yield firstResult.value;
          }
          yield* { [Symbol.asyncIterator]: () => rangeIterator };
        }

        const rangeStream = Readable.from(prependFirst());

        let firstChunkTime = 0;

        // Measure actual TTFB on first data event
        rangeStream.once('data', () => {
          firstChunkTime = Date.now() - rangeStartTime;
          span.setAttribute(
            'chunks.streaming.first_chunk_time_ms',
            firstChunkTime,
          );
        });

        rangeStream.on('end', () => {
          const chunksFetched = rangeResult.getChunksFetched();
          span.setAttributes({
            'chunks.streaming.fetched_count': chunksFetched,
          });

          span.addEvent('Range streaming completed');

          metrics.getDataStreamSuccessesTotal.inc({
            class: this.constructor.name,
            source: 'chunks',
            request_type: 'range',
          });

          // Track bytes streamed
          metrics.getDataStreamBytesTotal.inc(
            {
              class: this.constructor.name,
              source: 'chunks',
              request_type: 'range',
            },
            region.size,
          );

          metrics.getDataStreamSizeHistogram.observe(
            {
              class: this.constructor.name,
              source: 'chunks',
              request_type: 'range',
            },
            region.size,
          );

          // Track chunks fetched per request
          metrics.dataRequestChunksHistogram.observe(
            {
              class: this.constructor.name,
              source: 'chunks',
              request_type: 'range',
            },
            chunksFetched,
          );

          if (firstChunkTime > 0) {
            metrics.dataRequestFirstChunkLatency.observe(
              {
                class: this.constructor.name,
                source: 'chunks',
                request_type: 'range',
              },
              firstChunkTime,
            );
          }
        });

        rangeStream.on('error', (error) => {
          // Don't record AbortError as exception
          if (error.name !== 'AbortError') {
            span.recordException(error);
            metrics.getDataStreamErrorsTotal.inc({
              class: this.constructor.name,
              source: 'chunks',
              request_type: 'range',
            });
          }
        });

        rangeStream.pause();

        return {
          stream: rangeStream,
          size: region.size,
          totalSize: size,
          verified: true,
          trusted: true,
          cached: false,
          requestAttributes:
            generateRequestAttributes(requestAttributes)?.attributes,
        };
      }

      // Full streaming mode
      span.setAttribute('chunks.streaming.request_type', 'full');
      span.addEvent('Starting full streaming');

      // Rebind getChunkDataByAny to preserve access to it in the stream read
      // function since 'this' is assigned to the stream as opposed to the
      // TxChunksDataSource instance there.
      const getChunkDataByAny = (
        absoluteOffset: number,
        dataRoot: string,
        relativeOffset: number,
      ) =>
        this.concurrencyLimit(() =>
          this.chunkSource.getChunkDataByAny(
            {
              txSize: size,
              absoluteOffset,
              dataRoot,
              relativeOffset,
            },
            effectiveSignal,
          ),
        );

      let chunkDataPromise: Promise<ChunkData> | undefined = getChunkDataByAny(
        startOffset,
        txDataRoot,
        bytes,
      );

      this.log.debug('Fetching first chunk', {
        startOffset,
        txDataRoot,
        bytes,
        size,
      });

      // await the first chunk promise so that it throws and returns 404 if no
      // chunk data is found. Race against a timeout if configured.
      try {
        await chunkDataPromise!;
        timeout?.cleanup();
      } catch (error: any) {
        timeout?.cleanup();
        if (timeout?.signal.aborted) {
          throw new Error(
            `First chunk data timeout after ${this.firstDataTimeoutMs}ms`,
          );
        }
        throw error;
      }

      const streamStartTime = Date.now();

      // Upper bound on the number of chunks a well-formed tx can produce: each
      // chunk is at most MAX_CHUNK_SIZE bytes, so `size` bytes need at most
      // ceil(size / MAX_CHUNK_SIZE) chunks. The +1 tolerates boundary
      // rebalancing of the final chunks. This is a backstop against
      // pathological geometry (e.g. a corrupt tx size/offset) driving an
      // unbounded number of fetches.
      const maxChunks = Math.ceil(size / MAX_CHUNK_SIZE) + 1;

      const stream = new Readable({
        autoDestroy: true,
        read: async function () {
          try {
            // Check for abort before each chunk read
            effectiveSignal?.throwIfAborted();

            if (!chunkDataPromise) {
              this.push(null);
              return;
            }

            const chunkData = await chunkDataPromise;

            // Forward-progress guard: a zero-length chunk would not advance
            // `bytes`, leaving `bytes < size` true forever and re-requesting
            // the same offset indefinitely (observed as multi-million-span
            // traces of repeated cache hits on a single offset). Abort rather
            // than spin.
            if (size > 0 && chunkData.chunk.length === 0) {
              metrics.chunkStreamAbortsTotal.inc({
                reason: 'zero_length_chunk',
              });
              throw new Error(
                `Zero-length chunk for ${id} at relativeOffset ${bytes}; ` +
                  `aborting to avoid a non-terminating chunk loop`,
              );
            }

            // Backstop guard: never read more chunks than the tx size can hold.
            if (totalChunks >= maxChunks) {
              metrics.chunkStreamAbortsTotal.inc({
                reason: 'chunk_count_exceeded',
              });
              throw new Error(
                `Chunk count exceeded maximum ${maxChunks} for ${id} ` +
                  `(size ${size}); aborting chunk loop`,
              );
            }

            this.push(chunkData.chunk);
            totalChunks++;
            bytes += chunkData.chunk.length;

            if (bytes < size) {
              chunkDataPromise = getChunkDataByAny(
                startOffset + bytes,
                txDataRoot,
                bytes,
              );
            } else {
              chunkDataPromise = undefined;
            }
          } catch (error: any) {
            this.destroy(error);
          }
        },
      });

      let totalChunks = 0;

      // Measure actual TTFB on first data event
      stream.once('data', () => {
        const firstChunkTime = Date.now() - streamStartTime;
        span.setAttribute(
          'chunks.streaming.first_chunk_time_ms',
          firstChunkTime,
        );
      });

      stream.on('error', (error) => {
        // Don't record AbortError as exception
        if (error.name !== 'AbortError') {
          span.recordException(error);
          metrics.getDataStreamErrorsTotal.inc({
            class: this.constructor.name,
            source: 'chunks',
            request_type: 'full',
          });
        }
      });

      stream.on('end', () => {
        span.setAttributes({
          'chunks.streaming.total_chunks_processed': totalChunks,
        });

        span.addEvent('Full streaming completed');

        metrics.getDataStreamSuccessesTotal.inc({
          class: this.constructor.name,
          source: 'chunks',
          request_type: 'full',
        });
      });

      stream.pause();

      return {
        stream,
        size,
        totalSize: size,
        verified: true,
        trusted: true,
        cached: false,
        requestAttributes:
          generateRequestAttributes(requestAttributes)?.attributes,
      };
    } catch (error: any) {
      if (
        resolved !== undefined &&
        resolved.source !== 'chain' &&
        error !== null &&
        typeof error === 'object' &&
        error.name !== 'AbortError'
      ) {
        this.localGeometryErrors.set(error, resolved.geometry);
      }

      // Don't record AbortError as exception
      if (error.name === 'AbortError') {
        span.addEvent('Request aborted', {
          'data.retrieval.error': 'client_disconnected',
        });
        throw error;
      }

      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
        source: 'chunks',
      });
      throw error;
    } finally {
      combinedSignal?.clear();
      timeout?.cleanup();
      span.end();
    }
  }
}
