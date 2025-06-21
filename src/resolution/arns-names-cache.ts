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
import CircuitBreaker from 'opossum';

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
  private arnsNamesCircuitBreaker: CircuitBreaker<
    Parameters<AoARIORead['getArNSRecords']>,
    Awaited<ReturnType<AoARIORead['getArNSRecords']>>
  >;

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
    circuitBreakerOptions = {
      timeout: config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_TIMEOUT_MS,
      errorThresholdPercentage:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE,
      rollingCountTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_ROLLING_COUNT_TIMEOUT_MS,
      resetTimeout:
        config.ARIO_PROCESS_DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
    },
  }: {
    log: winston.Logger;
    registryCache: KVBufferStore;
    ao?: AoClient;
    networkProcess?: AoARIORead;
    cacheMissDebounceTtl?: number;
    cacheHitDebounceTtl?: number;
    circuitBreakerOptions?: CircuitBreaker.Options;
  }) {
    this.log = log.child({
      class: 'ArNSNamesCache',
    });
    this.networkProcess = networkProcess;
    this.arnsRegistryKvCache = registryCache;
    this.arnsNamesCircuitBreaker = new CircuitBreaker(
      this.networkProcess.getArNSRecords.bind(this.networkProcess),
      {
        ...circuitBreakerOptions,
        capacity: 1, // only allow one request at a time
        name: 'getArNSRecords',
      },
    );
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
    // add circuit breaker metrics
    metrics.circuitBreakerMetrics.add(this.arnsNamesCircuitBreaker);
  }

  /**
   * Paginate through all the names in the registry and hydrate the cache
   * with the names and their associated processId and undernameLimits. The ar-io-sdk
   * retries requests 3 times with exponential backoff by default.
   */
  private async hydrateArNSNamesCache() {
    try {
      this.log.info('Hydrating ArNS names cache...');
      let cursor: string | undefined = undefined;
      const start = Date.now();
      do {
        const {
          items: records,
          nextCursor,
        }: PaginationResult<AoArNSNameDataWithName> =
          await this.arnsNamesCircuitBreaker.fire({ cursor, limit: 1000 });
        for (const record of records) {
          // do not await, avoid blocking the event loop
          this.setCachedArNSBaseName(record.name, record);
        }
        cursor = nextCursor;
      } while (cursor !== undefined);
      metrics.arnsNameCacheDurationSummary.observe(Date.now() - start);
      this.log.info('Successfully hydrated ArNS names cache');
    } catch (error: any) {
      this.log.error('Error hydrating ArNS names cache', {
        error: error.message,
        stack: error.stack,
      });
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
   * @returns The ArNS name data for the given name, or undefined if the name is not found.
   */
  async getCachedArNSBaseName(
    name: string,
  ): Promise<AoArNSNameDataWithName | undefined> {
    const record = await this.arnsDebounceCache.get(name);
    if (record) {
      metrics.arnsNameCacheHitCounter.inc();
      return <AoArNSNameDataWithName>JSON.parse(record.toString());
    }
    metrics.arnsNameCacheMissCounter.inc();
    return undefined;
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
