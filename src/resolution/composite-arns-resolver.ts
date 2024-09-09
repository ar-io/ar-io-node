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
import { KVBufferStore, NameResolution, NameResolver } from '../types.js';
import * as metrics from '../metrics.js';

export class CompositeArNSResolver implements NameResolver {
  private log: winston.Logger;
  private resolvers: NameResolver[];
  private cache: KVBufferStore;

  constructor({
    log,
    resolvers,
    cache,
  }: {
    log: winston.Logger;
    resolvers: NameResolver[];
    cache: KVBufferStore;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.resolvers = resolvers;
    this.cache = cache;
  }

  private hashKey(key: string): string {
    return `arns|${key}`;
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });

    try {
      const cachedResolutionBuffer = await this.cache.get(this.hashKey(name));
      if (cachedResolutionBuffer) {
        const cachedResolution: NameResolution = JSON.parse(
          cachedResolutionBuffer.toString(),
        );
        if (
          cachedResolution !== undefined &&
          cachedResolution.resolvedAt !== undefined &&
          cachedResolution.ttl !== undefined &&
          cachedResolution.resolvedAt + cachedResolution.ttl * 1000 > Date.now()
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
          if (resolution.resolvedId !== undefined) {
            const hashKey = this.hashKey(name);
            const resolutionBuffer = Buffer.from(JSON.stringify(resolution));
            await this.cache.set(hashKey, resolutionBuffer);
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
      return {
        name,
        resolvedId: undefined,
        resolvedAt: undefined,
        processId: undefined,
        ttl: undefined,
      };
    } catch (error: any) {
      this.log.error('Error resolving name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
      return {
        name,
        resolvedId: undefined,
        resolvedAt: undefined,
        ttl: undefined,
        processId: undefined,
      };
    }
  }
}
