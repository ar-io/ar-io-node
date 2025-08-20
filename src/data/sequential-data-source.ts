/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  ContiguousData,
  ContiguousDataAttributes,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import { tracer } from '../tracing.js';

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
    dataAttributes,
    requestAttributes,
    region,
  }: {
    id: string;
    dataAttributes?: ContiguousDataAttributes;
    requestAttributes?: RequestAttributes;
    region?: Region;
  }): Promise<ContiguousData> {
    const span = tracer.startSpan('SequentialDataSource.getData', {
      attributes: {
        'data.id': id,
        'data.has_attributes': dataAttributes !== undefined,
        'data.has_region': region !== undefined,
        'data.region.offset': region?.offset,
        'data.region.size': region?.size,
        'arns.name': requestAttributes?.arnsName,
        'arns.basename': requestAttributes?.arnsBasename,
        'sequential.config.sources_count': this.dataSources.length,
      },
    });

    try {
      this.log.debug('Sequentialy fetching from data sources', {
        id,
      });

      span.addEvent('Starting sequential source attempts', {
        'sequential.attempt.sources_count': this.dataSources.length,
      });

      for (let i = 0; i < this.dataSources.length; i++) {
        const dataSource = this.dataSources[i];
        const sourceStart = Date.now();

        span.addEvent('Trying data source', {
          'sequential.attempt.source_index': i,
          'sequential.attempt.source_name': dataSource.constructor.name,
        });

        try {
          const data = await dataSource.getData({
            id,
            dataAttributes,
            requestAttributes,
            region,
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

          return data;
        } catch (error: any) {
          const sourceDuration = Date.now() - sourceStart;

          span.addEvent('Data source failed', {
            'sequential.source_index': i,
            'sequential.source_name': dataSource.constructor.name,
            'sequential.attempt.error': error.message,
            'sequential.attempt.duration_ms': sourceDuration,
          });

          // Some errors are expected, so log them as warnings
          this.log.warn('Unable to fetch data from data source', {
            id,
            sourceIndex: i,
            sourceName: dataSource.constructor.name,
            message: error.message,
            stack: error.stack,
          });
        }
      }

      span.setAttribute('sequential.all_sources_failed', true);
      span.addEvent('All sources exhausted');

      const finalError = new Error('Unable to fetch data from any data source');
      span.recordException(finalError);
      throw finalError;
    } catch (error: any) {
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}
