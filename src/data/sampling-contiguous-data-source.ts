/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createHash } from 'node:crypto';
import winston from 'winston';
import { Span } from '@opentelemetry/api';

import {
  ContiguousData,
  ContiguousDataSource,
  Region,
  RequestAttributes,
} from '../types.js';
import { startChildSpan } from '../tracing.js';
import * as metrics from '../metrics.js';
import { SamplingStrategy } from '../config.js';

/**
 * A wrapper around ContiguousDataSource that probabilistically routes requests
 * through an experimental data source. This enables safe A/B testing of new
 * retrieval strategies with controlled traffic exposure.
 *
 * When a request is sampled, it is forwarded to the inner data source.
 * When a request is not sampled, an error is thrown so that SequentialDataSource
 * can move to the next source in the chain.
 *
 * @example
 * ```typescript
 * const samplingSource = new SamplingContiguousDataSource({
 *   log,
 *   dataSource: experimentalSource,
 *   sourceName: 'experimental-chunks',
 *   samplingRate: 0.1, // 10% of requests
 *   strategy: 'deterministic', // same ID always gets same decision
 * });
 * ```
 */
export class SamplingContiguousDataSource implements ContiguousDataSource {
  private readonly log: winston.Logger;
  private readonly innerDataSource: ContiguousDataSource;
  private readonly sourceName: string;
  private readonly samplingRate: number;
  private readonly strategy: SamplingStrategy;

  constructor({
    log,
    dataSource,
    sourceName,
    samplingRate,
    strategy = 'random',
  }: {
    log: winston.Logger;
    dataSource: ContiguousDataSource;
    sourceName: string;
    samplingRate: number;
    strategy?: SamplingStrategy;
  }) {
    if (samplingRate < 0 || samplingRate > 1) {
      throw new Error(
        `samplingRate must be between 0 and 1, got: ${samplingRate}`,
      );
    }

    this.log = log.child({ class: this.constructor.name });
    this.innerDataSource = dataSource;
    this.sourceName = sourceName;
    this.samplingRate = samplingRate;
    this.strategy = strategy;

    this.log.info('SamplingContiguousDataSource initialized', {
      sourceName,
      samplingRate,
      strategy,
    });
  }

  /**
   * Determines whether a request should be sampled based on the configured strategy.
   *
   * @param id - The ID of the data being requested
   * @returns true if the request should be sampled
   */
  private shouldSample(id: string): boolean {
    if (this.strategy === 'random') {
      return Math.random() < this.samplingRate;
    }

    // Deterministic strategy: use sha256 hash of the ID
    // This ensures the same ID always gets the same sampling decision
    const hash = createHash('sha256').update(id).digest();
    // Take the first 4 bytes as an unsigned 32-bit integer
    const hashValue = hash.readUInt32BE(0);
    // Normalize to [0, 1) range (use 2^32 to ensure max hash < 1.0)
    const normalized = hashValue / 0x100000000;
    return normalized < this.samplingRate;
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
    // Check for abort before starting
    signal?.throwIfAborted();

    const sampled = this.shouldSample(id);

    // Record sampling decision metric
    metrics.samplingDecisionTotal.inc({
      source: this.sourceName,
      decision: sampled ? 'sampled' : 'skipped',
    });

    if (!sampled) {
      this.log.debug('Request not sampled', {
        id,
        sourceName: this.sourceName,
        strategy: this.strategy,
      });
      throw new Error(`Request not sampled for source: ${this.sourceName}`);
    }

    this.log.debug('Request sampled', {
      id,
      sourceName: this.sourceName,
      strategy: this.strategy,
    });

    // Create a child span for the sampled request
    const span = startChildSpan(
      'SamplingContiguousDataSource.getData',
      {
        attributes: {
          'sampling.source_name': this.sourceName,
          'sampling.strategy': this.strategy,
          'sampling.rate': this.samplingRate,
          'data.id': id,
          'data.has_region': region !== undefined,
          'data.region.offset': region?.offset,
          'data.region.size': region?.size,
        },
      },
      parentSpan,
    );

    const startTime = Date.now();

    try {
      const data = await this.innerDataSource.getData({
        id,
        requestAttributes,
        region,
        parentSpan: span,
        signal,
      });

      const latencyMs = Date.now() - startTime;

      // Record success metrics
      metrics.samplingRequestTotal.inc({
        source: this.sourceName,
        status: 'success',
      });
      metrics.samplingLatencyMs.observe(
        { source: this.sourceName, status: 'success' },
        latencyMs,
      );

      span.setAttributes({
        'sampling.result': 'success',
        'sampling.latency_ms': latencyMs,
        'data.cached': data.cached,
        'data.trusted': data.trusted,
      });
      span.end();

      return data;
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;

      // Re-throw AbortError immediately without recording as error
      if (error.name === 'AbortError') {
        span.setAttributes({
          'sampling.result': 'aborted',
          'sampling.latency_ms': latencyMs,
        });
        span.end();
        throw error;
      }

      // Record error metrics
      metrics.samplingRequestTotal.inc({
        source: this.sourceName,
        status: 'error',
      });
      metrics.samplingLatencyMs.observe(
        { source: this.sourceName, status: 'error' },
        latencyMs,
      );

      this.log.warn('Sampled request failed', {
        id,
        sourceName: this.sourceName,
        message: error.message,
        latencyMs,
      });

      span.setAttributes({
        'sampling.result': 'error',
        'sampling.latency_ms': latencyMs,
        'sampling.error': error.message,
      });
      span.recordException(error);
      span.end();

      throw error;
    }
  }
}
