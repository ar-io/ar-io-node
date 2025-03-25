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
import pTimeout from 'p-timeout';
import pLimit from 'p-limit';
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
  private pendingResolutions: Record<
    string,
    Promise<NameResolution | undefined> | undefined
  > = {};
  private limit: ReturnType<typeof pLimit>;
  private resolverTimeoutMs: number;

  constructor({
    log,
    resolvers,
    resolutionCache,
    registryCache,
    overrides,
    networkProcess,
    maxConcurrentResolutions = 2,
    resolverTimeoutMs = config.ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS,
  }: {
    log: winston.Logger;
    resolvers: NameResolver[];
    resolutionCache: KvArNSResolutionStore;
    registryCache: KvArNSRegistryStore;
    networkProcess?: AoARIORead;
    overrides?: {
      ttlSeconds?: number;
    };
    maxConcurrentResolutions?: number;
    resolverTimeoutMs?: number;
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
    this.limit = pLimit(maxConcurrentResolutions);
    this.resolverTimeoutMs = resolverTimeoutMs;
  }

  private async resolveWithResolver(
    resolver: NameResolver,
    name: string,
    baseArNSRecordFn: () => Promise<any>,
    isLastResolver: boolean,
  ): Promise<NameResolution | undefined> {
    try {
      const resolutionPromise = resolver
        .resolve({
          name,
          baseArNSRecordFn,
        })
        .then((resolution) => {
          if (resolution.resolvedAt !== undefined) {
            this.resolutionCache.set(
              name,
              Buffer.from(JSON.stringify(resolution)),
            );
            this.log.info('Resolved name', { name, resolution });
            return resolution;
          }
          return undefined;
        });

      if (isLastResolver) {
        return await resolutionPromise;
      }

      return await pTimeout(resolutionPromise, {
        milliseconds: this.resolverTimeoutMs,
      });
    } catch (error: any) {
      this.log.error('Error resolving name with resolver', {
        resolver: resolver.constructor.name,
        message: error.message,
        stack: error.stack,
      });
      return undefined;
    }
  }

  private async resolveParallel(
    name: string,
    baseArNSRecordFn: () => Promise<any>,
  ): Promise<NameResolution | undefined> {
    const resolutionPromises = this.resolvers.map((resolver, index) => {
      const isLastResolver = index === this.resolvers.length - 1;
      return this.limit(() =>
        this.resolveWithResolver(
          resolver,
          name,
          baseArNSRecordFn,
          isLastResolver,
        ).then((resolution) => {
          // Only consider resolutions with resolvedAt as successful
          if (resolution?.resolvedAt !== undefined) {
            return resolution;
          }
          throw new Error('No valid resolution');
        }),
      );
    });

    try {
      return await Promise.any(resolutionPromises);
    } catch (error: any) {
      this.log.error('Error during parallel resolution:', {
        message: error.message,
        stack: error.stack,
      });
      return undefined;
    }
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
        limit: undefined,
        index: undefined,
      };
    }

    try {
      const baseArNSRecordFn = async () => {
        return this.arnsNamesCache
          .getCachedArNSBaseName(baseName)
          .catch((error: any) => {
            this.log.error('Error getting base name from cache: ', {
              message: error.message,
              stack: error.stack,
              baseName,
            });
            return undefined;
          });
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
          // Resolve again in the background to refresh cache if TTL is close
          // to expiring
          if (
            // Ensure only one resolution is in-flight at a time
            !this.pendingResolutions[name] &&
            cachedResolution.resolvedAt + ttlSeconds * 1000 - Date.now() <
              config.ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS
          ) {
            this.pendingResolutions[name] = this.resolveParallel(
              name,
              baseArNSRecordFn,
            );
          }
          metrics.arnsCacheHitCounter.inc();
          this.log.info('Cache hit for arns name', { name });
          return cachedResolution;
        }
      }
      metrics.arnsCacheMissCounter.inc();
      this.log.info('Cache miss for arns name', { name });

      // Ensure that we always use pending resolutions
      this.pendingResolutions[name] ||= this.resolveParallel(
        name,
        baseArNSRecordFn,
      );
      // Fallback to cached resolution if something goes wrong
      resolution = await (resolution
        ? pTimeout(this.pendingResolutions[name], {
            milliseconds: config.ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS,
            fallback: () => resolution,
          })
        : this.pendingResolutions[name]);

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

    // Ensure the pending resolution is cleaned up
    this.pendingResolutions[name] = undefined;

    // return the resolution if it exists, otherwise return an empty resolution
    return (
      resolution ?? {
        name,
        resolvedId: undefined,
        resolvedAt: undefined,
        ttl: undefined,
        processId: undefined,
        limit: undefined,
        index: undefined,
      }
    );
  }
}
