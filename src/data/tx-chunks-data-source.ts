/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';
import { anySignal, ClearableSignal } from 'any-signal';
import pLimit, { LimitFunction } from 'p-limit';
import winston from 'winston';
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
} from '../types.js';
import * as metrics from '../metrics.js';

export class TxChunksDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private chainSource: ChainSource;
  private chunkSource: ChunkDataByAnySource & ChunkByAnySource;
  private concurrencyLimit: LimitFunction;
  private firstDataTimeoutMs: number;

  constructor({
    log,
    chainSource,
    chunkSource,
    concurrencyLimit,
    firstDataTimeoutMs = 0,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    chunkSource: ChunkDataByAnySource & ChunkByAnySource;
    concurrencyLimit?: LimitFunction;
    firstDataTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
    this.concurrencyLimit = concurrencyLimit ?? pLimit(Infinity);
    this.firstDataTimeoutMs = firstDataTimeoutMs;
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

  async getData({
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
  }): Promise<ContiguousData> {
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

    try {
      // Check for abort before starting
      signal?.throwIfAborted();

      this.log.debug('Fetching chunk data for TX', { id });

      span.addEvent('Starting chain source requests');
      const [txDataRoot, txOffset] = await Promise.all([
        this.chainSource.getTxField(id, 'data_root'),
        this.chainSource.getTxOffset(id),
      ]);
      const size = +txOffset.size;
      const offset = +txOffset.offset;
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
      });

      span.addEvent('Chain source requests completed');

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
