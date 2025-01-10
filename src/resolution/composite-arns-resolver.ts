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
import { NameResolution, NameResolver } from '../types.js';
import * as metrics from '../metrics.js';
import { KvArNSResolutionStore } from '../store/kv-arns-name-resolution-store.js';
import { KvDebounceStore } from '../store/kv-debounce-store.js';
import {
  AoARIORead,
  AoArNSNameDataWithName,
  AOProcess,
  ARIO,
  PaginationResult,
} from '@ar.io/sdk';
import * as config from '../config.js';
import { connect } from '@permaweb/aoconnect';
import { KvArNSRegistryStore } from '../store/kv-arns-base-name-store.js';

export class CompositeArNSResolver implements NameResolver {
  private log: winston.Logger;
  private resolvers: NameResolver[];
  private resolutionCache: KvArNSResolutionStore;
  private registryDebounceCache: KvDebounceStore;
  private overrides:
    | {
        ttlSeconds?: number;
        // TODO: other overrides like fallback txId if not found in resolution
      }
    | undefined;

  constructor({
    log,
    resolvers,
    resolutionCache,
    networkProcess = ARIO.init({
      process: new AOProcess({
        processId: config.IO_PROCESS_ID,
        ao: connect({
          MU_URL: config.AO_MU_URL,
          CU_URL: config.AO_CU_URL,
          GRAPHQL_URL: config.AO_GRAPHQL_URL,
          GATEWAY_URL: config.AO_GATEWAY_URL,
        }),
      }),
    }),
    registryCache,
    overrides,
  }: {
    log: winston.Logger;
    resolvers: NameResolver[];
    networkProcess?: AoARIORead;
    resolutionCache: KvArNSResolutionStore;
    registryCache: KvArNSRegistryStore;
    overrides?: {
      ttlSeconds?: number;
    };
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.resolvers = resolvers;
    this.resolutionCache = resolutionCache;
    this.overrides = overrides;

    // wrap the registry cache in a debounce cache that calls hydrateFn on cache miss and cache hit
    this.registryDebounceCache = new KvDebounceStore({
      kvBufferStore: registryCache,
      cacheMissDebounceTtl:
        config.ARNS_NAME_LIST_CACHE_MISS_REFRESH_INTERVAL_SECONDS,
      cacheHitDebounceTtl:
        config.ARNS_NAME_LIST_CACHE_HIT_REFRESH_INTERVAL_SECONDS,
      hydrateFn: async () => {
        /**
         * Paginate through all the names in the registry and hydrate the cache
         * with the names and their associated processId and undernameLimits. The ar-io-sdk
         * retries requests 3 times with exponential backoff by default.
         */
        try {
          this.log.info('Hydrating ArNS names cache...');
          let cursor: string | undefined = undefined;
          // TODO: add timing metrics
          do {
            const {
              items: records,
              nextCursor,
            }: PaginationResult<AoArNSNameDataWithName> =
              await networkProcess.getArNSRecords({ cursor, limit: 1000 });
            for (const record of records) {
              // do not await, avoid blocking the event loop
              registryCache.set(
                record.name,
                Buffer.from(JSON.stringify(record)),
              );
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
      },
    });
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name, overrides: this.overrides });
    let resolution: NameResolution | undefined;

    // parse out base arns name, if undername
    const baseName = name.split('_').pop();
    if (baseName === undefined) {
      return {
        name,
        resolvedId: undefined,
        resolvedAt: undefined,
        ttl: undefined,
        processId: undefined,
      };
    }

    try {
      // check if our base name is in our arns names cache, this triggers a debounce with a ttl dependent on if it's in the cache or not
      const baseNameInCache = await this.registryDebounceCache.get(baseName);

      if (!baseNameInCache) {
        throw new Error('Base name not found in ArNS names cache');
      }

      // check if our resolution cache contains the FULL name
      const cachedResolutionBuffer = await this.resolutionCache.get(name);
      if (cachedResolutionBuffer) {
        const cachedResolution: NameResolution = JSON.parse(
          cachedResolutionBuffer.toString(),
        );
        resolution = cachedResolution; // hold on to this in case we need it
        // use the override ttl if it exists, otherwise use the cached resolution ttl
        const ttlSeconds = this.overrides?.ttlSeconds ?? cachedResolution.ttl;
        if (
          cachedResolution !== undefined &&
          cachedResolution.resolvedAt !== undefined &&
          ttlSeconds !== undefined &&
          cachedResolution.resolvedAt + ttlSeconds * 1000 > Date.now()
        ) {
          metrics.arnsCacheHitCounter.inc();
          this.log.info('Cache hit for arns name', { name });
          return cachedResolution;
        }
      }
      metrics.arnsCacheMissCounter.inc();
      this.log.info('Cache miss for arns name', { name });

      for (const resolver of this.resolvers) {
        try {
          this.log.info('Attempting to resolve name with resolver', {
            type: resolver.constructor.name,
            name,
          });
          const resolution = await resolver.resolve(name);
          if (resolution.resolvedAt !== undefined) {
            this.resolutionCache.set(
              name,
              Buffer.from(JSON.stringify(resolution)),
            );
            this.log.info('Resolved name', { name, resolution });
            return resolution;
          }
        } catch (error: any) {
          this.log.error('Error resolving name with resolver', {
            resolver,
            message: error.message,
            stack: error.stack,
          });
        }
      }
      this.log.warn('Unable to resolve name against all resolvers', { name });
    } catch (error: any) {
      this.log.error('Error resolving name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
    }

    // return the resolution if it exists, otherwise return an empty resolution
    return (
      resolution ?? {
        name,
        resolvedId: undefined,
        resolvedAt: undefined,
        ttl: undefined,
        processId: undefined,
      }
    );
  }
}
