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
import { OnDemandArNSResolver } from '../resolution/on-demand-arns-resolver.js';
import { TrustedGatewayArNSResolver } from '../resolution/trusted-gateway-arns-resolver.js';
import { KVBufferStore, NameResolver } from '../types.js';
import { AoARIORead } from '@ar.io/sdk';
import { CompositeArNSResolver } from '../resolution/composite-arns-resolver.js';
import { RedisKvStore } from '../store/redis-kv-store.js';
import { NodeKvStore } from '../store/node-kv-store.js';
import { KvArNSRegistryStore } from '../store/kv-arns-base-name-store.js';
import { KvArNSResolutionStore } from '../store/kv-arns-name-resolution-store.js';

const supportedResolvers = ['on-demand', 'gateway'] as const;
export type ArNSResolverType = (typeof supportedResolvers)[number];

export const isArNSResolverType = (type: string): type is ArNSResolverType => {
  return supportedResolvers.includes(type as ArNSResolverType);
};

export const createArNSKvStore = ({
  log,
  type,
  redisUrl,
  ttlSeconds,
  maxKeys,
}: {
  type: 'redis' | 'node' | string;
  log: Logger;
  redisUrl: string;
  ttlSeconds: number;
  maxKeys: number;
}): KVBufferStore => {
  log.info(`Using ${type} as KVBufferStore for arns`, {
    type,
    redisUrl,
    ttlSeconds,
    maxKeys,
  });
  if (type === 'redis') {
    return new RedisKvStore({
      log,
      redisUrl,
      ttlSeconds,
    });
  }
  return new NodeKvStore({ ttlSeconds, maxKeys });
};

export const createArNSResolver = ({
  log,
  resolutionCache,
  resolutionOrder,
  registryCache,
  trustedGatewayUrl,
  networkProcess,
  overrides,
}: {
  log: Logger;
  resolutionCache: KvArNSResolutionStore;
  resolutionOrder: (ArNSResolverType | string)[];
  registryCache: KvArNSRegistryStore;
  trustedGatewayUrl?: string;
  networkProcess?: AoARIORead;
  overrides?: {
    ttlSeconds?: number;
  };
}): NameResolver => {
  const resolverMap: Record<ArNSResolverType, NameResolver | undefined> = {
    'on-demand': new OnDemandArNSResolver({
      log,
      networkProcess,
    }),
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
    } else {
      log.warn(`Ignoring unsupported resolver type: ${resolverType}`);
    }
  }

  log.info(
    `Using ${resolvers.map((r) => r.constructor.name).join(',')} for arns name resolution`,
  );

  return new CompositeArNSResolver({
    log,
    resolvers,
    resolutionCache,
    registryCache,
    networkProcess,
    overrides,
  });
};
