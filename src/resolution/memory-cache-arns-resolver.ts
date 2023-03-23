import { default as NodeCache } from 'node-cache';
import winston from 'winston';

import { NameResolution, NameResolver } from '../types.js';

export class MemoryCacheArNSResolver implements NameResolver {
  private log: winston.Logger;
  private resolver: NameResolver;
  private requestCache = new NodeCache({
    checkperiod: 60 * 5, // 5 minutes
    stdTTL: 60 * 60 * 2, // 2 hours
    useClones: false, // cloning promises is unsafe
    maxKeys: 10000,
  });

  constructor({
    log,
    resolver,
  }: {
    log: winston.Logger;
    resolver: NameResolver;
  }) {
    this.log = log.child({ class: 'MemoryCacheArNSResolver' });
    this.resolver = resolver;
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });

    try {
      // Attempt to resolve from memory cache
      let resolutionPromise = this.requestCache.get(name);
      let resolution = (await resolutionPromise) as NameResolution | undefined;
      if (resolution) {
        const { resolvedAt, ttl } = resolution;
        if (resolvedAt !== undefined && Date.now() < resolvedAt + ttl * 1000) {
          this.log.info('Resolved name from cache', resolution);
          return resolution;
        }
      }

      // Fallback to resolver if cache is empty or expired
      resolutionPromise = this.resolver.resolve(name);
      try {
        this.requestCache.set(name, resolutionPromise);
      } catch (error: any) {
        this.log.warn('Unable to set cache:', {
          name,
          message: error.message,
          stack: error.stack,
        });
      }
      resolution = (await resolutionPromise) as NameResolution;
      const { resolvedAt, ttl } = resolution;
      if (resolvedAt !== undefined && Date.now() < resolvedAt + ttl) {
        this.log.info('Resolved name from resolver', resolution);
        return resolution;
      } else {
        this.log.warn('Unable to resolve name', { name });
      }
    } catch (error: any) {
      this.log.warn('Unable to resolve name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
    }

    // Return empty resolution if unable to resolve from cache or resolver
    return {
      name,
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
    };
  }
}
