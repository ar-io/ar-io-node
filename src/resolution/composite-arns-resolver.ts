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
import { KvArNSRegistryStore } from '../store/kv-arns-base-name-store.js';
import { ArNSNamesCache } from './arns-names-cache.js';
import { AoARIORead } from '@ar.io/sdk';
import * as config from '../config.js';

export class CompositeArNSResolver implements NameResolver {
  private log: winston.Logger;
  private resolvers: NameResolver[];
  private resolutionCache: KvArNSResolutionStore;
  private overrides:
    | {
        ttlSeconds?: number;
        // TODO: other overrides like fallback txId if not found in resolution
      }
    | undefined;
  private arnsNamesCache: ArNSNamesCache;
  private hasPendingResolution: Record<string, boolean> = {};

  constructor({
    log,
    resolvers,
    resolutionCache,
    registryCache,
    overrides,
    networkProcess,
  }: {
    log: winston.Logger;
    resolvers: NameResolver[];
    resolutionCache: KvArNSResolutionStore;
    registryCache: KvArNSRegistryStore;
    networkProcess?: AoARIORead;
    overrides?: {
      ttlSeconds?: number;
    };
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.resolvers = resolvers;
    this.resolutionCache = resolutionCache;
    this.overrides = overrides;
    this.arnsNamesCache = new ArNSNamesCache({
      log,
      registryCache,
      networkProcess,
    });
  }

  async resolve({ name }: { name: string }): Promise<NameResolution> {
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
      // start name list request before checking cache so that the name list
      // stays fresh even when there are cache hits
      const baseNameInCachePromise = this.arnsNamesCache
        .getCachedArNSBaseName(baseName)
        .catch((error: any) => {
          this.log.error('Error getting base name from cache: ', {
            message: error.message,
            stack: error.stack,
            baseName,
          });
          return undefined;
        });

      const resolveName = async () => {
        this.hasPendingResolution[name] = true;

        for (const resolver of this.resolvers) {
          try {
            this.log.info('Attempting to resolve name with resolver', {
              type: resolver.constructor.name,
              name,
            });
            const resolution = await resolver.resolve({
              name,
              baseArNSRecord: baseNameInCache,
            });
            if (resolution.resolvedAt !== undefined) {
              this.resolutionCache.set(
                name,
                Buffer.from(JSON.stringify(resolution)),
              );
              this.log.info('Resolved name', { name, resolution });

              this.hasPendingResolution[name] = false;
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

        this.hasPendingResolution[name] = false;
        return undefined;
      };

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
          this.log.debug('Checking if cached ArNS resolution needs refresh', {
            name,
            hasPendingResolution: this.hasPendingResolution[name],
            cacheAge: Date.now() - cachedResolution.resolvedAt! * 1000,
            refreshInterval: config.ARNS_ANT_STATE_CACHE_HIT_REFRESH_INTERVAL_SECONDS,
          });
          if (
            !this.hasPendingResolution[name] &&
            Date.now() - cachedResolution.resolvedAt * 1000 >
              config.ARNS_ANT_STATE_CACHE_HIT_REFRESH_INTERVAL_SECONDS
          ) {
            resolveName();
          }
          metrics.arnsCacheHitCounter.inc();
          this.log.info('Cache hit for arns name', { name });
          return cachedResolution;
        }
      }
      metrics.arnsCacheMissCounter.inc();
      this.log.info('Cache miss for arns name', { name });

      const baseNameInCache = await baseNameInCachePromise;

      if (!baseNameInCache) {
        this.log.warn('Base name not found in ArNS names cache', { name });
        metrics.arnsNameCacheMissCounter.inc();
        return {
          name,
          resolvedId: undefined,
          resolvedAt: undefined,
          ttl: undefined,
          processId: undefined,
        };
      }

      resolution = (await resolveName()) ?? resolution;

      if (!resolution) {
        this.log.warn('Unable to resolve name against all resolvers', { name });
      }
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
