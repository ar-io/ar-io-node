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
import { Logger } from 'winston';
import { StandaloneArNSResolver } from '../resolution/standalone-arns-resolver.js';
import { OnDemandArNSResolver } from '../resolution/on-demand-arns-resolver.js';
import { TrustedGatewayArNSResolver } from '../resolution/trusted-gateway-arns-resolver.js';
import { NameResolver } from '../types.js';
import { AoIORead } from '@ar.io/sdk';
import { CompositeArNSResolver } from '../resolution/composite-arns-resolver.js';

export const createArNSResolver = ({
  log,
  type,
  standaloneArnResolverUrl,
  trustedGatewayUrl,
  networkProcess,
}: {
  log: Logger;
  type: string;
  standaloneArnResolverUrl?: string;
  trustedGatewayUrl?: string;
  networkProcess?: AoIORead;
}): NameResolver => {
  log.info(`Using ${type} for arns name resolution`);
  switch (type) {
    case 'on-demand': {
      const resolvers: NameResolver[] = [];
      if (standaloneArnResolverUrl !== undefined) {
        resolvers.push(
          new StandaloneArNSResolver({
            log,
            resolverUrl: standaloneArnResolverUrl,
          }),
        );
      }
      if (trustedGatewayUrl !== undefined) {
        resolvers.push(
          new TrustedGatewayArNSResolver({
            log,
            trustedGatewayUrl,
          }),
        );
      }
      return new CompositeArNSResolver({
        log,
        resolvers: [
          new OnDemandArNSResolver({
            log,
            networkProcess,
          }),
          ...resolvers,
        ],
      });
    }
    case 'resolver': {
      if (standaloneArnResolverUrl === undefined) {
        throw new Error(
          'Standalone ArNS resolver URL is required to use resolver type',
        );
      }
      return new CompositeArNSResolver({
        log,
        resolvers: [
          new StandaloneArNSResolver({
            log,
            resolverUrl: standaloneArnResolverUrl,
          }),
          // fallback to on-demand resolver if the standalone resolver fails
          new OnDemandArNSResolver({
            log,
            networkProcess,
          }),
        ],
      });
    }
    case 'gateway': {
      if (trustedGatewayUrl === undefined) {
        throw new Error('Trusted Gateway URL is required to use gateway type');
      }
      return new CompositeArNSResolver({
        log,
        resolvers: [
          new TrustedGatewayArNSResolver({
            log,
            trustedGatewayUrl,
          }),
          // fallback to on-demand resolver if the gateway resolver fails
          new OnDemandArNSResolver({
            log,
            networkProcess,
          }),
        ],
      });
    }
    default: {
      throw new Error(`Unknown ArNSResolver type: ${type}`);
    }
  }
};
