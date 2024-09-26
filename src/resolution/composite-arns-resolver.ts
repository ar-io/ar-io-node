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
import { KvArnsStore } from '../store/kv-arns-store.js';

export class CompositeArNSResolver implements NameResolver {
  private log: winston.Logger;
  private resolvers: NameResolver[];
  private cache: KvArnsStore;
  private overrides:
    | {
        ttlSeconds?: number;
        // TODO: other overrides like fallback txId if not found in resolution
      }
    | undefined;

  constructor({
    log,
    resolvers,
    cache,
    overrides,
  }: {
    log: winston.Logger;
    resolvers: NameResolver[];
    cache: KvArnsStore;
    overrides?: {
      ttlSeconds?: number;
    };
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.resolvers = resolvers;
    this.cache = cache;
    this.overrides = overrides;
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name, overrides: this.overrides });
    let resolution: NameResolution | undefined;

    try {
      const cachedResolutionBuffer = await this.cache.get(name);
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
            this.cache.set(name, Buffer.from(JSON.stringify(resolution)));
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
