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

const supportedResolvers = ['on-demand', 'resolver', 'gateway'] as const;
export type ArNSResolverType = (typeof supportedResolvers)[number];

export const isArNSResolverType = (type: string): type is ArNSResolverType => {
  return supportedResolvers.includes(type as ArNSResolverType);
};

export const createArNSResolver = ({
  log,
  resolutionOrder,
  standaloneArnResolverUrl,
  trustedGatewayUrl,
  networkProcess,
}: {
  log: Logger;
  resolutionOrder: (ArNSResolverType | string)[];
  standaloneArnResolverUrl?: string;
  trustedGatewayUrl?: string;
  networkProcess?: AoIORead;
}): NameResolver => {
  log.info(`Using ${resolutionOrder} for arns name resolution`);
  const resolverMap: Record<ArNSResolverType, NameResolver | undefined> = {
    'on-demand': new OnDemandArNSResolver({
      log,
      networkProcess,
    }),
    resolver:
      standaloneArnResolverUrl !== undefined
        ? new StandaloneArNSResolver({
            log,
            resolverUrl: standaloneArnResolverUrl,
          })
        : undefined,
    gateway:
      trustedGatewayUrl !== undefined
        ? new TrustedGatewayArNSResolver({
            log,
            trustedGatewayUrl,
          })
        : undefined,
  };

  const resolvers: NameResolver[] = [];

  // add resolvers in the order specified by resolutionOrder
  for (const resolverType of resolutionOrder) {
    if (isArNSResolverType(resolverType)) {
      const resolver = resolverMap[resolverType];
      if (resolver !== undefined) {
        resolvers.push(resolver);
      }
    }
    log.warn(`Ignoring unsupported resolver type: ${resolverType}`);
  }

  return new CompositeArNSResolver({
    log,
    resolvers,
  });
};
