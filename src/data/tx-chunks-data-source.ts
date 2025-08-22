/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { Readable } from 'node:stream';
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

  constructor({
    log,
    chainSource,
    chunkSource,
  }: {
    log: winston.Logger;
    chainSource: ChainSource;
    chunkSource: ChunkDataByAnySource & ChunkByAnySource;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.chainSource = chainSource;
    this.chunkSource = chunkSource;
  }

  async getData({
    id,
    requestAttributes,
    region,
    parentSpan,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
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

    try {
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
        }) => this.chunkSource.getChunkByAny(params);

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
        });

        const rangeStream = Readable.from(rangeResult.stream);

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
          span.recordException(error);

          metrics.getDataStreamErrorsTotal.inc({
            class: this.constructor.name,
            source: 'chunks',
            request_type: 'range',
          });
        });

        return {
          stream: rangeStream,
          size: region.size,
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
        this.chunkSource.getChunkDataByAny({
          txSize: size,
          absoluteOffset,
          dataRoot,
          relativeOffset,
        });

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
      // chunk data is found.
      await chunkDataPromise;

      const streamStartTime = Date.now();

      const stream = new Readable({
        autoDestroy: true,
        read: async function () {
          try {
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
        span.recordException(error);

        metrics.getDataStreamErrorsTotal.inc({
          class: this.constructor.name,
          source: 'chunks',
          request_type: 'full',
        });
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
        verified: true,
        trusted: true,
        cached: false,
        requestAttributes:
          generateRequestAttributes(requestAttributes)?.attributes,
      };
    } catch (error: any) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

      metrics.getDataErrorsTotal.inc({
        class: this.constructor.name,
        source: 'chunks',
      });
      throw error;
    } finally {
      span.end();
    }
  }
}
