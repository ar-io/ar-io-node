/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import winston from 'winston';
import pTimeout from 'p-timeout';
import pLimit from 'p-limit';
import { anySignal } from 'any-signal';
import { context, trace, Span } from '@opentelemetry/api';
import { NameResolution, NameResolver } from '../types.js';
import * as metrics from '../metrics.js';
import { KvArNSResolutionStore } from '../store/kv-arns-name-resolution-store.js';
import { KvArNSRegistryStore } from '../store/kv-arns-base-name-store.js';
import { ArNSNamesCache } from './arns-names-cache.js';
import { AoARIORead } from '@ar.io/sdk';
import * as config from '../config.js';
import { tracer } from '../tracing.js';

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
  private maxConcurrentResolutions: number;
  private resolverTimeoutMs: number;
  private lastResolverTimeoutMs: number;
  private arnsAntStateCacheHitRefreshWindowSeconds: number;
  private arnsCachedResolutionFallbackTimeoutMs: number;

  constructor({
    log,
    resolvers,
    resolutionCache,
    registryCache,
    networkProcess,
    overrides,
    arnsNamesCache,
    maxConcurrentResolutions = config.ARNS_MAX_CONCURRENT_RESOLUTIONS,
    resolverTimeoutMs = config.ARNS_COMPOSITE_RESOLVER_TIMEOUT_MS,
    lastResolverTimeoutMs:
      lastResolverTimeoutMs = config.ARNS_COMPOSITE_LAST_RESOLVER_TIMEOUT_MS,
    arnsAntStateCacheHitRefreshWindowSeconds = config.ARNS_ANT_STATE_CACHE_HIT_REFRESH_WINDOW_SECONDS,
    arnsCachedResolutionFallbackTimeoutMs = config.ARNS_CACHED_RESOLUTION_FALLBACK_TIMEOUT_MS,
  }: {
    log: winston.Logger;
    resolvers: NameResolver[];
    resolutionCache: KvArNSResolutionStore;
    registryCache: KvArNSRegistryStore;
    networkProcess?: AoARIORead;
    overrides?: {
      ttlSeconds?: number;
    };
    arnsNamesCache?: ArNSNamesCache;
    maxConcurrentResolutions?: number;
    resolverTimeoutMs?: number;
    lastResolverTimeoutMs?: number;
    arnsAntStateCacheHitRefreshWindowSeconds?: number;
    arnsCachedResolutionFallbackTimeoutMs?: number;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.resolvers = resolvers;
    this.resolutionCache = resolutionCache;
    this.overrides = overrides;
    this.arnsNamesCache =
      arnsNamesCache ??
      new ArNSNamesCache({
        log,
        registryCache,
        networkProcess,
      });
    this.maxConcurrentResolutions = maxConcurrentResolutions
      ? Math.min(maxConcurrentResolutions, this.resolvers.length)
      : this.resolvers.length;
    this.resolverTimeoutMs = resolverTimeoutMs;
    this.lastResolverTimeoutMs = lastResolverTimeoutMs;
    this.arnsAntStateCacheHitRefreshWindowSeconds =
      arnsAntStateCacheHitRefreshWindowSeconds;
    this.arnsCachedResolutionFallbackTimeoutMs =
      arnsCachedResolutionFallbackTimeoutMs;
  }

  private async resolveWithResolver({
    resolver,
    name,
    baseArNSRecordFn,
    isLastResolver,
    signal,
    parentSpan,
  }: {
    resolver: NameResolver;
    name: string;
    baseArNSRecordFn: () => Promise<any>;
    isLastResolver: boolean;
    signal: AbortSignal;
    parentSpan: Span;
  }): Promise<NameResolution | undefined> {
    const resolutionPromise = (async () => {
      const span = tracer.startSpan(
        'CompositeArNSResolver.resolveWithResolver.resolutionPromise',
        {
          attributes: {
            arnsName: name,
            resolver: resolver.constructor.name,
          },
        },
        trace.setSpan(context.active(), parentSpan),
      );
      try {
        const resolution = await resolver.resolve({
          name,
          baseArNSRecordFn,
          signal,
        });

        // Only cache and return resolutions where resolvedAt is set
        if (resolution.resolvedAt !== undefined) {
          this.resolutionCache.set(
            name,
            Buffer.from(JSON.stringify(resolution)),
          );
          span.addEvent('Saved resolution to cache');

          metrics.arnsResolutionResolverCount.inc({
            resolver: resolver.constructor.name,
          });

          this.log.verbose('Resolved name', {
            name,
            resolution,
            resolvedBy: resolver.constructor.name,
          });

          return resolution;
        }

        return undefined;
      } catch (e: any) {
        const error = e as Error;
        this.log.error('Error resolving name with resolver', {
          name,
          resolver: resolver.constructor.name,
          message: error.message,
          stack: error.stack,
        });
        span.recordException(error);
        return undefined;
      } finally {
        span.end();
      }
    })();

    return pTimeout(resolutionPromise, {
      milliseconds: isLastResolver
        ? this.lastResolverTimeoutMs
        : this.resolverTimeoutMs,
      signal,
    });
  }

  private async resolveParallel({
    name,
    baseArNSRecordFn,
    signal,
    parentSpan,
  }: {
    name: string;
    baseArNSRecordFn: () => Promise<any>;
    signal: AbortSignal;
    parentSpan: Span;
  }): Promise<NameResolution | undefined> {
    const span = tracer.startSpan(
      'CompositeArNSResolver.resolverParallel',
      { attributes: { arnsName: name } },
      trace.setSpan(context.active(), parentSpan),
    );

    // Return the pending resolution for the name if it exists
    if (this.pendingResolutions[name]) {
      span.addEvent('Using pending resolution');
      span.end();
      return this.pendingResolutions[name];
    }

    const limit = pLimit(this.maxConcurrentResolutions);
    const alreadyResolvedAbort = new AbortController();
    const resolutionPromises = this.resolvers.map((resolver, index) => {
      const isLastResolver = index === this.resolvers.length - 1;
      return limit(async () => {
        const resolution = await this.resolveWithResolver({
          resolver,
          name,
          baseArNSRecordFn,
          isLastResolver,
          signal: anySignal([signal, alreadyResolvedAbort.signal]),
          parentSpan: span,
        });

        if (resolution) {
          // Clear limit queue and signal running resolvers to abort when we
          // find a valid resolution
          limit.clearQueue();
          alreadyResolvedAbort.abort();
          return resolution;
        }
        throw new Error('Invalid resolution');
      });
    });

    try {
      // The initial check for pending resolutions and subsequent lack of
      // awaits in this method ensures this.pendingResolutions[name] is
      // undefined when we get here. Thus there will never be more than one
      // pending resolution for the name.
      this.pendingResolutions[name] = Promise.any(resolutionPromises);
      return await this.pendingResolutions[name];
    } catch (e: any) {
      const error = e as Error;
      this.log.error('Error during parallel resolution:', {
        name,
        resolvers: this.resolvers.map((r) => r.constructor.name),
        message: error.message,
        stack: error.stack,
      });
      span.recordException(error as Error);
      return undefined;
    } finally {
      // Ensure the pending resolution is cleaned up after resolution completes
      this.pendingResolutions[name] = undefined;
      span.end();
    }
  }

  async resolve({
    name,
    signal = new AbortController().signal,
  }: {
    name: string;
    signal?: AbortSignal;
  }): Promise<NameResolution> {
    const span = tracer.startSpan('CompositeArNSResolver.resolve', {
      attributes: {
        arnsName: name,
      },
    });
    this.log.info('Resolving name...', { name, overrides: this.overrides });

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
        try {
          // NOTE: The name cache handles its own request deduplication
          return await this.arnsNamesCache.getCachedArNSBaseName(baseName);
        } catch (error: any) {
          this.log.error('Error getting base name from names cache: ', {
            baseName,
            message: error.message,
            stack: error.stack,
          });
          return undefined;
        }
      };

      // Check if the resolution cache contains the FULL name
      const cachedResolutionBuffer = await this.resolutionCache.get(name);
      const cachedResolution =
        cachedResolutionBuffer !== undefined
          ? (JSON.parse(cachedResolutionBuffer.toString()) as NameResolution)
          : undefined;
      if (cachedResolution) {
        // Use the override TTL if it exists, otherwise use the cached
        // resolution TTL
        const ttlSeconds = this.overrides?.ttlSeconds ?? cachedResolution.ttl;
        span.addEvent('Found cached resolution', {
          resolvedAt: cachedResolution.resolvedAt,
          ttl: cachedResolution.ttl,
          effectiveTtl: ttlSeconds,
        });

        // Use the cached resolution if its fresh enough
        if (
          cachedResolution.resolvedAt !== undefined &&
          ttlSeconds !== undefined &&
          cachedResolution.resolvedAt + ttlSeconds * 1000 > Date.now()
        ) {
          // Resolve in the background to refresh the cache if the TTL is close
          // to expiring
          if (
            cachedResolution.resolvedAt + ttlSeconds * 1000 - Date.now() <
            this.arnsAntStateCacheHitRefreshWindowSeconds * 1000
          ) {
            const innerSpan = tracer.startSpan(
              'CompositeArNSResolver.backgroundRefresh',
              { attributes: { arnsName: name } },
              trace.setSpan(context.active(), span),
            );
            this.resolveParallel({
              name,
              baseArNSRecordFn,
              signal,
              parentSpan: innerSpan,
            }).finally(() => {
              innerSpan.end();
            });
          }
          metrics.arnsCacheHitCounter.inc();
          span.addEvent('Using cached resolution within TTL');
          this.log.verbose('Resolution cache hit for ArNS name', { name });
          return cachedResolution;
        }
      }
      metrics.arnsCacheMissCounter.inc();
      this.log.verbose('Resolution cache miss for ArNS name', { name });

      // If there is a cached resolution, fall back to it if either an error
      // occurs or we exceed the cached resolution fallback timeout
      let usedCachedFallback = false;
      const resolution = await (cachedResolution
        ? // Cached resultion exists
          pTimeout(
            this.resolveParallel({
              name,
              baseArNSRecordFn,
              signal: signal,
              parentSpan: span,
            }),
            {
              milliseconds: this.arnsCachedResolutionFallbackTimeoutMs,
              fallback: () => {
                usedCachedFallback = true;
                span.addEvent(
                  'Using cached resolution due to fallback timeout',
                );
                return cachedResolution;
              },
              signal,
            },
          )
        : // No cached resolution exists
          this.resolveParallel({
            name,
            baseArNSRecordFn,
            signal,
            parentSpan: span,
          }));

      if (resolution) {
        if (usedCachedFallback) {
          span.addEvent('Resolved by cache fallback');
        } else {
          span.addEvent('Resolved by fresh resolution');
        }
        return resolution;
      }

      span.addEvent('Unable to resolve name');
      this.log.warn('Unable to resolve name against all resolvers', { name });
    } catch (e: any) {
      const error = e as Error;
      this.log.error('Error resolving name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
      span.recordException(error as Error);
    } finally {
      span.end();
    }

    // No resolution found
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
}
