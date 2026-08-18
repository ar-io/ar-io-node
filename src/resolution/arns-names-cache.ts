/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';

import { ARIORead, ArNSNameDataWithName, PaginationResult } from '@ar.io/sdk';
import * as config from '../config.js';
import { KvDebounceStore } from '../store/kv-debounce-store.js';
import { KVBufferStore } from '../types.js';
import * as metrics from '../metrics.js';
import { tracer } from '../tracing.js';
import { context, trace, Span } from '@opentelemetry/api';

const DEFAULT_CACHE_MISS_DEBOUNCE_TTL =
  config.ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS * 1000;
const DEFAULT_CACHE_HIT_DEBOUNCE_TTL =
  config.ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS * 1000;
const DEFAULT_PAGE_SIZE = config.ARNS_NAME_LIST_PAGE_SIZE;
/**
 * Per-page attempts made here, on top of whatever the `ARIORead`
 * implementation already does internally. See ARNS_NAME_LIST_MAX_RETRIES.
 */
const DEFAULT_MAX_RETRIES = config.ARNS_NAME_LIST_MAX_RETRIES;

/**
 * How many registry writes are kept in flight at once during hydration.
 *
 * A page can now hold the whole registry, and every write is a real I/O call
 * on the configured store, so the page is drained in bounded chunks: it caps
 * in-flight work on the store, and yields to the event loop between chunks
 * instead of queueing thousands of operations in one uninterrupted pass.
 */
const CACHE_WRITE_CHUNK_SIZE = 500;

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
  private networkProcess: ARIORead;
  private arnsRegistryKvCache: KVBufferStore;
  private arnsDebounceCache: KvDebounceStore;
  private pageSize: number;
  private maxRetries: number;

  constructor({
    log,
    registryCache,
    networkProcess,
    cacheMissDebounceTtl = DEFAULT_CACHE_MISS_DEBOUNCE_TTL,
    cacheHitDebounceTtl = DEFAULT_CACHE_HIT_DEBOUNCE_TTL,
    pageSize = DEFAULT_PAGE_SIZE,
    maxRetries = DEFAULT_MAX_RETRIES,
  }: {
    log: winston.Logger;
    registryCache: KVBufferStore;
    networkProcess: ARIORead;
    cacheMissDebounceTtl?: number;
    cacheHitDebounceTtl?: number;
    pageSize?: number;
    maxRetries?: number;
  }) {
    // Both values come from `+env.varOrDefault(...)`, so a malformed env var
    // arrives here as NaN. Fail loudly at construction rather than degrading
    // silently: pageSize < 1 makes `paginate` return an empty page while
    // still reporting hasMore, so the hydration loop never terminates; and
    // maxRetries < 1 skips the fetch entirely and reports a successful
    // hydration with an empty cache.
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
      throw new Error(
        `ArNSNamesCache: pageSize must be a positive integer, got ${pageSize}`,
      );
    }
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 1) {
      throw new Error(
        `ArNSNamesCache: maxRetries must be a positive integer, got ${maxRetries}`,
      );
    }
    this.pageSize = pageSize;
    this.maxRetries = maxRetries;
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
   *
   * Note on page size: the Solana-backed `getArNSRecords` paginates
   * client-side -- each call runs a full `getProgramAccounts` scan of the ArNS
   * program and slices the result. A page size smaller than the registry
   * therefore repeats that scan once per page. `pageSize` defaults to
   * ARNS_NAME_LIST_PAGE_SIZE so a typical registry is walked in one request.
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
      const maxRetries = this.maxRetries;
      let totalPages = 0;
      let failedPages = 0;
      let totalRetries = 0;
      let cachedNames = 0;
      let failedWrites = 0;
      let firstWriteError: any;

      do {
        let retryCount = 0;
        let success = false;
        totalPages++;

        while (retryCount < maxRetries && !success) {
          try {
            const {
              items: records,
              nextCursor,
            }: PaginationResult<ArNSNameDataWithName> =
              await this.networkProcess.getArNSRecords({
                cursor,
                limit: this.pageSize,
              });

            /**
             * Writes are chunked and their failures collected rather than
             * issued as one uncaught fire-and-forget burst. Both stores can
             * fail here in normal operation: `NodeKvStore` throws
             * `Cache max keys amount exceeded` once the registry outgrows
             * ARNS_CACHE_MAX_KEYS, and `RedisKvStore` rejects while Redis is
             * unreachable.
             *
             * Uncaught, each failed write became its own unhandled rejection.
             * The `uncaughtException` handler in system.ts keeps the process
             * alive, so the cost was not a crash but a silent one: measured
             * against a 3007-name registry with ARNS_CACHE_MAX_KEYS=1000,
             * 2007 uncaught exceptions, and a gauge still reporting 3007
             * entries for a cache holding 1000. Two thirds of ArNS names
             * 404ed with nothing in the logs naming the cause.
             *
             * A failed write is counted and logged instead of aborting the
             * page: losing one name to a transient store error should not
             * discard the rest of the registry or trigger a full re-scan.
             */
            let pendingWrites: Promise<void>[] = [];
            const flushWrites = async () => {
              await Promise.all(pendingWrites);
              pendingWrites = [];
            };

            for (const record of records) {
              pendingWrites.push(
                this.setCachedArNSBaseName(record.name, record).then(
                  () => {
                    cachedNames++;
                  },
                  (writeError: any) => {
                    failedWrites++;
                    firstWriteError ??= writeError;
                    metrics.arnsNameCacheHydrationWriteFailuresCounter.inc();
                  },
                ),
              );

              if (pendingWrites.length >= CACHE_WRITE_CHUNK_SIZE) {
                await flushWrites();
              }
            }

            await flushWrites();

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
        'arns.cache.hydration.failed_writes': failedWrites,
        'arns.cache.hydration.success': true,
      });

      // Counts names actually written, so the gauge reports the cache the
      // resolver can read rather than the number of records fetched.
      metrics.arnsBaseNameCacheEntriesGauge.set(cachedNames);

      if (failedWrites > 0) {
        // A partially hydrated cache resolves some names and 404s the rest,
        // which is otherwise indistinguishable from a name that was never
        // registered. Make it loud.
        this.log.error('Failed to cache some ArNS names during hydration', {
          failedWrites,
          cachedNames,
          error: firstWriteError?.message,
        });
      }

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
  ): Promise<ArNSNameDataWithName | undefined> {
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
        return <ArNSNameDataWithName>JSON.parse(record.toString());
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
  async setCachedArNSBaseName(name: string, record: ArNSNameDataWithName) {
    return this.arnsRegistryKvCache.set(
      name,
      Buffer.from(JSON.stringify(record)),
    );
  }

  async close() {
    await this.arnsDebounceCache.close();
  }
}
