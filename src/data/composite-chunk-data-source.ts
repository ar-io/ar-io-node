/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import pLimit from 'p-limit';
import { tracer } from '../tracing.js';

import {
  ChunkData,
  ChunkDataByAnySource,
  ChunkDataByAnySourceParams,
} from '../types.js';

export class CompositeChunkDataSource implements ChunkDataByAnySource {
  private log: winston.Logger;
  private sources: ChunkDataByAnySource[];
  private parallelism: number;

  constructor({
    log,
    sources,
    parallelism = 1,
  }: {
    log: winston.Logger;
    sources: ChunkDataByAnySource[];
    parallelism?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.sources = sources;
    this.parallelism = Math.max(1, Math.min(parallelism, sources.length));
  }

  async getChunkDataByAny(
    params: ChunkDataByAnySourceParams,
  ): Promise<ChunkData> {
    const span = tracer.startSpan(
      'CompositeChunkDataSource.getChunkDataByAny',
      {
        attributes: {
          'chunk.data_root': params.dataRoot,
          'chunk.absolute_offset': params.absoluteOffset,
          'chunk.relative_offset': params.relativeOffset,
          'chunk.tx_size': params.txSize,
          'chunk.sources_count': this.sources.length,
          'chunk.parallelism': this.parallelism,
        },
      },
    );

    try {
      if (this.sources.length === 0) {
        const error = new Error('No chunk data sources configured');
        span.recordException(error);
        throw error;
      }

      span.addEvent('Starting source attempts', {
        sources: this.sources.map((source) => source.constructor.name),
      });

      const errors: Error[] = [];
      const limit = pLimit(this.parallelism);
      let successResult: ChunkData | undefined;
      let successfulSource: string | undefined;

      // Create all promises at once, controlled by pLimit
      const promises = this.sources.map((source, index) =>
        limit(async () => {
          // Check if we already have a success before starting
          if (successResult) {
            span.addEvent('Skipping source due to early success', {
              source: source.constructor.name,
              source_index: index,
            });
            return null;
          }

          const sourceStartTime = Date.now();
          span.addEvent('Trying source', {
            source: source.constructor.name,
            source_index: index,
          });

          try {
            const result = await source.getChunkDataByAny(params);
            const sourceDuration = Date.now() - sourceStartTime;

            // Check again after async operation
            if (successResult !== undefined) {
              span.addEvent('Source succeeded but result already available', {
                source: source.constructor.name,
                source_index: index,
                duration_ms: sourceDuration,
              });
              return null;
            }

            span.addEvent('Source succeeded', {
              source: source.constructor.name,
              source_index: index,
              chunk_source: result.source,
              chunk_host: result.sourceHost,
              duration_ms: sourceDuration,
            });

            this.log.debug('Successfully fetched chunk data from source', {
              source: source.constructor.name,
              chunkSource: result.source,
              chunkHost: result.sourceHost,
              dataRoot: params.dataRoot,
              relativeOffset: params.relativeOffset,
            });

            // Store success result
            successResult = result;
            successfulSource = source.constructor.name;
            return result;
          } catch (error: any) {
            const sourceDuration = Date.now() - sourceStartTime;

            // Check again if we got a success while this was running
            if (successResult) {
              span.addEvent('Source failed but result already available', {
                source: source.constructor.name,
                source_index: index,
                duration_ms: sourceDuration,
              });
              return null;
            }

            span.addEvent('Source failed', {
              source: source.constructor.name,
              source_index: index,
              error: error.message,
              duration_ms: sourceDuration,
            });

            this.log.debug('Failed to fetch chunk data from source', {
              source: source.constructor.name,
              error: error.message,
              dataRoot: params.dataRoot,
              relativeOffset: params.relativeOffset,
            });
            errors.push(error);
            return null;
          }
        }),
      );

      // Wait for all promises to complete
      await Promise.all(promises);

      // Return success if we got one
      if (successResult) {
        span.setAttributes({
          'chunk.successful_source': successfulSource ?? 'unknown',
          'chunk.final_source': successResult.source ?? 'unknown',
          'chunk.final_source_host': successResult.sourceHost ?? 'unknown',
        });
        span.addEvent('Composite source retrieval successful');
        return successResult;
      }

      // All sources failed
      span.setAttributes({
        'chunk.failed_sources_count': errors.length,
        'chunk.total_errors': errors.length,
      });

      const errorMessage = `Failed to fetch chunk data from any source. Errors: ${errors
        .map((e) => e.message)
        .join('; ')}`;

      const error = new Error(errorMessage);
      span.recordException(error);
      throw error;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
