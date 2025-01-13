/**
 * AR.IO Gateway
 * Copyright (C) 2022-2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
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
      CU_URL: config.AO_CU_URL,
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
      debounceFn: this.hydrateArNSNamesCache.bind(this),
    });
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
      // TODO: add timing metrics
      do {
        const {
          items: records,
          nextCursor,
        }: PaginationResult<AoArNSNameDataWithName> =
          await this.networkProcess.getArNSRecords({ cursor, limit: 1000 });
        for (const record of records) {
          // do not await, avoid blocking the event loop
          this.setCachedArNSBaseName(record.name, record);
        }
        cursor = nextCursor;
      } while (cursor !== undefined);
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
      return <AoArNSNameDataWithName>JSON.parse(record.toString());
    }
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
