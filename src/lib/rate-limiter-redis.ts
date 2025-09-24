/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Redis from 'ioredis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RATE_LIMITER_REDIS_ENDPOINT,
  RATE_LIMITER_REDIS_USE_TLS,
  RATE_LIMITER_REDIS_USE_CLUSTER,
} from '../config.js';
import logger from '../log.js';

export interface TokenBucket {
  key: string;
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number;
  contentLength?: number;
}

export interface RateLimiterRedisClient {
  getOrCreateBucket(
    key: string,
    capacity: number,
    refillRate: number,
    now: number,
    ttlSeconds: number,
  ): Promise<string>;
  consumeTokens(
    key: string,
    tokensToConsume: number,
    now: number,
    ttlSeconds: number,
    contentLength?: number,
  ): Promise<number>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lazy initialization - only create the client when it's first accessed
let _rlIoRedisClient: RateLimiterRedisClient | undefined;

export function getRateLimiterRedisClient(): RateLimiterRedisClient {
  if (!_rlIoRedisClient) {
    const useCluster = RATE_LIMITER_REDIS_USE_CLUSTER === 'true';

    function parseEndpoint(ep: string) {
      const bracket = ep.match(/^\[(.+)\]:(\d+)$/);
      if (bracket) return { host: bracket[1], port: Number(bracket[2]) };
      const idx = ep.lastIndexOf(':');
      if (idx === -1) throw new Error('Invalid redis endpoint: ' + ep);
      return { host: ep.slice(0, idx), port: Number(ep.slice(idx + 1)) };
    }

    const endpoints = RATE_LIMITER_REDIS_ENDPOINT.split(',').map((e) =>
      e.trim(),
    );

    const tlsOpt = RATE_LIMITER_REDIS_USE_TLS === 'true' ? {} : undefined;

    const client = useCluster
      ? new Redis.Cluster(
          endpoints.map((ep) => parseEndpoint(ep)),
          {
            dnsLookup: (address, callback) => callback(null, address),
            redisOptions: {
              tls: tlsOpt,
            },
          },
        )
      : (() => {
          const { host, port } = parseEndpoint(endpoints[0]);
          return new Redis.Redis(port, host, {
            tls: tlsOpt,
          });
        })();

    // Handle connection events
    client.on('error', (error: unknown) => {
      logger.error('[rateLimiterCache] Redis connection error:', {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    client.defineCommand('getOrCreateBucket', {
      numberOfKeys: 1,
      lua: fs.readFileSync(
        path.join(__dirname, 'redis-lua/get-or-create-bucket.lua'),
        'utf8',
      ),
    });

    client.defineCommand('consumeTokens', {
      numberOfKeys: 1,
      lua: fs.readFileSync(
        path.join(__dirname, 'redis-lua/consume-tokens.lua'),
        'utf8',
      ),
    });

    _rlIoRedisClient = client as unknown as RateLimiterRedisClient;
  }

  return _rlIoRedisClient;
}
