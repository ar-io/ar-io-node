/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import { startChildSpan } from '../tracing.js';
import { Span } from '@opentelemetry/api';

export class SequentialDataSource implements ContiguousDataSource {
  private log: winston.Logger;
  private dataSources: ContiguousDataSource[];

  constructor({
    log,
    dataSources,
  }: {
    log: winston.Logger;
    dataSources: ContiguousDataSource[];
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.dataSources = dataSources;
  }

  async getData({
    id,
    requestAttributes,
    region,
    parentSpan,
    signal,
    acceptContentType,
  }: {
    id: string;
    requestAttributes?: RequestAttributes;
    region?: Region;
    parentSpan?: Span;
    signal?: AbortSignal;
    acceptContentType?: (contentType: string | undefined) => boolean;
  }): Promise<ContiguousData> {
    const span = startChildSpan(
      'SequentialDataSource.getData',
      {
        attributes: {
          'data.id': id,
          'data.has_region': region !== undefined,
          'data.region.offset': region?.offset,
          'data.region.size': region?.size,
          'arns.name': requestAttributes?.arnsName,
          'arns.basename': requestAttributes?.arnsBasename,
          'sequential.config.sources_count': this.dataSources.length,
        },
      },
      parentSpan,
    );

    try {
      // Check for abort before starting
      signal?.throwIfAborted();

      this.log.debug('Sequentialy fetching from data sources', {
        id,
      });

      span.addEvent('Starting sequential source attempts', {
        'sequential.attempt.sources_count': this.dataSources.length,
      });

      for (let i = 0; i < this.dataSources.length; i++) {
        // Check for abort before each source attempt
        signal?.throwIfAborted();

        const dataSource = this.dataSources[i];
        const sourceStart = Date.now();

        // Create a child span for each data source attempt
        const sourceSpan = startChildSpan(
          `SequentialDataSource.attempt[${i}]`,
          {
            attributes: {
              'sequential.attempt.source_index': i,
              'sequential.attempt.source_name': dataSource.constructor.name,
              'data.id': id,
            },
          },
          span,
        );

        span.addEvent('Trying data source', {
          'sequential.attempt.source_index': i,
          'sequential.attempt.source_name': dataSource.constructor.name,
        });

        try {
          const data = await dataSource.getData({
            id,
            requestAttributes,
            region,
            parentSpan: sourceSpan,
            signal,
            acceptContentType,
          });

          const sourceDuration = Date.now() - sourceStart;

          span.setAttributes({
            'sequential.result.successful_source_index': i,
            'sequential.result.successful_source_name':
              dataSource.constructor.name,
            'sequential.result.duration_ms': sourceDuration,
            'data.cached': data.cached,
            'data.trusted': data.trusted,
          });

          span.addEvent('Data source successful', {
            'sequential.source_index': i,
            'sequential.source_name': dataSource.constructor.name,
            'sequential.attempt.duration_ms': sourceDuration,
            'data.cached': data.cached,
            'data.trusted': data.trusted,
          });

          sourceSpan.setAttributes({
            'sequential.attempt.result': 'success',
            'sequential.attempt.duration_ms': sourceDuration,
          });
          sourceSpan.end();

          return data;
        } catch (error: any) {
          const sourceDuration = Date.now() - sourceStart;

          // Only short-circuit the whole cascade on a genuine client
          // disconnect, i.e. when the shared request signal was actually
          // aborted. A source's *internal* timeout (e.g. GatewaysDataSource's
          // per-gateway connection timeout) is also surfaced as an AbortError
          // via normalizeAbortError, but in that case the shared signal is NOT
          // aborted — those must fall through to the next source rather than
          // failing the entire request. This mirrors the
          // `error.name === 'AbortError' && req.signal?.aborted` check used at
          // the handler boundary in routes/data/handlers.ts.
          if (error.name === 'AbortError' && signal?.aborted === true) {
            span.addEvent('Request aborted', {
              'sequential.source_index': i,
              'sequential.source_name': dataSource.constructor.name,
              'data.retrieval.error': 'client_disconnected',
            });
            sourceSpan.setAttributes({
              'sequential.attempt.result': 'aborted',
              'sequential.attempt.duration_ms': sourceDuration,
            });
            sourceSpan.end();
            throw error;
          }

          span.addEvent('Data source failed', {
            'sequential.source_index': i,
            'sequential.source_name': dataSource.constructor.name,
            'sequential.attempt.error': error.message,
            'sequential.attempt.duration_ms': sourceDuration,
          });

          // Falling through to the next source is the cascade's designed
          // behaviour, not a failure: the overwhelming majority of these
          // attempts belong to requests that succeed on a later source. Log at
          // debug and omit the stack -- serialising one per fallthrough is pure
          // overhead on the hot path. Requests that exhaust every source still
          // surface as a warning from the data handler ('Unable to retrieve
          // contiguous data'), so terminal failures remain visible.
          this.log.debug('Unable to fetch data from data source', {
            id,
            sourceIndex: i,
            sourceName: dataSource.constructor.name,
            message: error.message,
          });

          sourceSpan.setAttributes({
            'sequential.attempt.result': 'error',
            'sequential.attempt.duration_ms': sourceDuration,
            'sequential.attempt.error': error.message,
          });
          sourceSpan.recordException(error);
          sourceSpan.end();
        }
      }

      span.setAttribute('sequential.all_sources_failed', true);
      span.addEvent('All sources exhausted');

      const finalError = new Error('Unable to fetch data from any data source');
      span.recordException(finalError);
      throw finalError;
    } catch (error: any) {
      // Don't record AbortError as exception
      if (error.name !== 'AbortError') {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }
}
