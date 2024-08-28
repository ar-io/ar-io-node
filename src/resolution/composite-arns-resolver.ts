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

export class CompositeArNSResolver implements NameResolver {
  private log: winston.Logger;
  private resolvers: NameResolver[];

  constructor({
    log,
    resolvers,
  }: {
    log: winston.Logger;
    resolvers: NameResolver[];
  }) {
    this.log = log.child({ class: 'CompositeArNSResolver' });
    this.resolvers = resolvers;
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });

    try {
      for (const resolver of this.resolvers) {
        this.log.debug('Attempting to resolve name with resolver', {
          resolver,
        });
        const resolution = await resolver.resolve(name);
        if (resolution.resolvedId !== undefined) {
          return resolution;
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
