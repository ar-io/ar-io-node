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
import { default as axios } from 'axios';
import winston from 'winston';

import { isValidDataId } from '../lib/validation.js';
import { NameResolution, NameResolver } from '../types.js';
import { DEFAULT_ARNS_TTL_SECONDS } from './trusted-gateway-arns-resolver.js';

export class StandaloneArNSResolver implements NameResolver {
  private log: winston.Logger;
  private resolverUrl: string;

  constructor({
    log,
    resolverUrl,
  }: {
    log: winston.Logger;
    resolverUrl: string;
  }) {
    this.log = log.child({
      class: 'StandaloneArNSResolver',
      resolverUrl: resolverUrl,
    });
    this.resolverUrl = resolverUrl;
  }

  async resolve(name: string): Promise<NameResolution> {
    this.log.info('Resolving name...', { name });
    try {
      const { data } = await axios<{
        txId: string;
        ttlSeconds: number;
        processId: string;
      }>({
        method: 'GET',
        url: `/ar-io/resolver/records/${name}`,
        baseURL: this.resolverUrl,
        validateStatus: (status) => status === 200,
      });

      const resolvedId = data.txId;
      const ttl = data.ttlSeconds || DEFAULT_ARNS_TTL_SECONDS;
      const processId = data.processId;

      if (!isValidDataId(resolvedId)) {
        throw new Error('Invalid resolved data ID');
      }

      this.log.info('Resolved name', {
        name,
        resolvedId,
        ttl,
      });
      return {
        name,
        resolvedId,
        resolvedAt: Date.now(),
        processId: processId,
        ttl,
      };
    } catch (error: any) {
      this.log.warn('Unable to resolve name:', {
        name,
        message: error.message,
        stack: error.stack,
      });
    }

    return {
      name,
      resolvedId: undefined,
      resolvedAt: undefined,
      ttl: undefined,
      processId: undefined,
    };
  }
}
