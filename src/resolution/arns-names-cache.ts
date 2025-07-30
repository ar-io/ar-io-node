/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import {
  AoClient,
  AoARIORead,
  AOProcess,
  ARIO,
  AoArNSNameDataWithName,
  PaginationResult,
} from '@ar.io/sdk';
import * as config from '../config.js';
import { connect } from '@permaweb/aoconnect';
import { KvDebounceStore } from '../store/kv-debounce-store.js';
import { KVBufferStore } from '../types.js';
import * as metrics from '../metrics.js';
import { tracer } from '../tracing.js';
import { context, trace, Span } from '@opentelemetry/api';

const DEFAULT_CACHE_MISS_DEBOUNCE_TTL =
  config.ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS * 1000;
const DEFAULT_CACHE_HIT_DEBOUNCE_TTL =
  config.ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS * 1000;

/**
 * Wraps an ArNS registry cache in a debounce cache that automatically refreshes
 * the cache after the debounce ttl has expired.
 *
 * The cache is a two-tier cache:
 * 1. A KVBufferStore that is used to store the ArNS name data.
 * 2. A KvDebounceStore that is used to debounce cache misses and cache hits.
 */
export class ArNSNamesCache {
  private log: winston.Logger;
  private networkProcess: AoARIORead;
  private arnsRegistryKvCache: KVBufferStore;
  private arnsDebounceCache: KvDebounceStore;

  constructor({
    log,
    registryCache,
    ao = connect({
      MU_URL: config.AO_MU_URL,
      CU_URL: config.NETWORK_AO_CU_URL,
      GRAPHQL_URL: config.AO_GRAPHQL_URL,
      GATEWAY_URL: config.AO_GATEWAY_URL,
    }),
    networkProcess = ARIO.init({
      process: new AOProcess({
        processId: config.IO_PROCESS_ID,
        ao: ao,
      }),
    }),
    cacheMissDebounceTtl = DEFAULT_CACHE_MISS_DEBOUNCE_TTL,
    cacheHitDebounceTtl = DEFAULT_CACHE_HIT_DEBOUNCE_TTL,
  }: {
    log: winston.Logger;
    registryCache: KVBufferStore;
    ao?: AoClient;
    networkProcess?: AoARIORead;
    cacheMissDebounceTtl?: number;
    cacheHitDebounceTtl?: number;
  }) {
    this.log = log.child({
      class: 'ArNSNamesCache',
    });
    this.networkProcess = networkProcess;
    this.arnsRegistryKvCache = registryCache;
    this.arnsDebounceCache = new KvDebounceStore({
      kvBufferStore: registryCache,
      cacheMissDebounceTtl,
      cacheHitDebounceTtl,
      debounceImmediately: true,
      /**
       * Bind the hydrateArNSNamesCache method to the ArNSNamesCache instance
       * so that the debounceFn has access to this instance's properties and methods (e.g. this.log, this.networkProcess, etc.).
       */
      hydrateFn: this.hydrateArNSNamesCache.bind(this),
    });
  }

  /**
   * Paginate through all the names in the registry and hydrate the cache
   * with the names and their associated processId and undernameLimits. The ar-io-sdk
   * retries requests 3 times with exponential backoff by default.
   */
  private async hydrateArNSNamesCache(parentSpan?: Span) {
    const span = parentSpan
      ? tracer.startSpan(
          'ArNSNamesCache.hydrateArNSNamesCache',
          {},
          trace.setSpan(context.active(), parentSpan),
        )
      : tracer.startSpan('ArNSNamesCache.hydrateArNSNamesCache');

    try {
      this.log.info('Hydrating ArNS names cache...');
      let cursor: string | undefined = undefined;
      const start = Date.now();
      const maxRetries = 3;
      let totalPages = 0;
      let failedPages = 0;
      let totalRetries = 0;
      let cachedNames = 0;

      do {
        let retryCount = 0;
        let success = false;
        totalPages++;

        while (retryCount < maxRetries && !success) {
          try {
            const {
              items: records,
              nextCursor,
            }: PaginationResult<AoArNSNameDataWithName> =
              await this.networkProcess.getArNSRecords({ cursor, limit: 1000 });

            for (const record of records) {
              // do not await, avoid blocking the event loop
              this.setCachedArNSBaseName(record.name, record);
              cachedNames++;
            }

            metrics.arnsNameCacheHydrationPagesCounter.inc();

            cursor = nextCursor;
            success = true;
          } catch (pageError: any) {
            retryCount++;
            totalRetries++;
            metrics.arnsNameCacheHydrationRetriesCounter.inc();

            span.addEvent('Page fetch failed', {
              cursor: cursor ?? 'initial',
              attempt: retryCount,
              error: pageError.message,
            });

            if (retryCount >= maxRetries) {
              failedPages++;
              this.log.error('Failed to fetch page after max retries', {
                cursor,
                attempts: retryCount,
                error: pageError.message,
              });
              throw pageError;
            }

            this.log.warn('Page fetch failed, retrying', {
              cursor,
              attempt: retryCount,
              error: pageError.message,
            });
          }
        }
      } while (cursor !== undefined);

      const duration = Date.now() - start;
      metrics.arnsNameCacheDurationSummary.observe(duration);

      span.setAttributes({
        'arns.cache.hydration.duration_ms': duration,
        'arns.cache.hydration.total_pages': totalPages,
        'arns.cache.hydration.failed_pages': failedPages,
        'arns.cache.hydration.total_retries': totalRetries,
        'arns.cache.hydration.cached_names': cachedNames,
        'arns.cache.hydration.success': true,
      });

      metrics.arnsBaseNameCacheEntriesGauge.set(cachedNames);

      this.log.info('Successfully hydrated ArNS names cache');
    } catch (error: any) {
      span.recordException(error);
      span.setAttributes({
        'arns.cache.hydration.success': false,
        'error.type': error.name || 'UnknownError',
      });

      metrics.arnsNameCacheHydrationFailuresCounter.inc();

      this.log.error('Error hydrating ArNS names cache', {
        error: error.message,
        stack: error.stack,
      });
    } finally {
      span.end();
    }
  }

  /**
   * Ignore debounce and hydrate the cache immediately
   */
  public async forceRefresh() {
    // TODO: could add clear() to KvBufferStore to clear out all cached items before hydrating
    return this.hydrateArNSNamesCache();
  }

  /**
   * Get the ArNS name data for a given name. The debounce cache will
   * automatically refresh the cache after the debounce ttl has expired.
   * @param name - The name to get the ArNS name data for.
   * @param parentSpan - Optional parent span for distributed tracing
   * @returns The ArNS name data for the given name, or undefined if the name is not found.
   */
  async getCachedArNSBaseName(
    name: string,
    parentSpan?: Span,
  ): Promise<AoArNSNameDataWithName | undefined> {
    const span = parentSpan
      ? tracer.startSpan(
          'ArNSNamesCache.getCachedArNSBaseName',
          {
            attributes: {
              'arns.cache.name': name,
            },
          },
          trace.setSpan(context.active(), parentSpan),
        )
      : tracer.startSpan('ArNSNamesCache.getCachedArNSBaseName', {
          attributes: {
            'arns.cache.name': name,
          },
        });

    try {
      const record = await this.arnsDebounceCache.get(name);
      if (record) {
        metrics.arnsNameCacheHitCounter.inc();
        span.setAttributes({ 'arns.cache.hit': true });
        return <AoArNSNameDataWithName>JSON.parse(record.toString());
      }
      metrics.arnsNameCacheMissCounter.inc();
      span.setAttributes({ 'arns.cache.hit': false });
      return undefined;
    } finally {
      span.end();
    }
  }

  /**
   * Set the ArNS name data for a given name.
   * @param name - The name to set the ArNS name data for.
   * @param record - The ArNS name data to set.
   */
  async setCachedArNSBaseName(name: string, record: AoArNSNameDataWithName) {
    return this.arnsRegistryKvCache.set(
      name,
      Buffer.from(JSON.stringify(record)),
    );
  }

  async close() {
    await this.arnsDebounceCache.close();
  }
}
