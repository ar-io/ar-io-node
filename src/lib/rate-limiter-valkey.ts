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
import * as env from './env.js';
import logger from '../log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TokenBucket {
  key: string;
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillRate: number;
  contentLength?: number;
}

// TODO: Make configurable as opt-in
const valkeyServerlessEndpoint = env.varOrDefault(
  'RATE_LIMITER_SERVERLESS_ENDPOINT',
  'localhost:6379',
);

const [valkeyHost, valkeyPort] = valkeyServerlessEndpoint.split(':');

export const rlIoRedisClient = new Redis.Cluster(
  [
    {
      host: valkeyHost,
      port: +valkeyPort,
    },
  ],
  {
    dnsLookup: (address, callback) => callback(null, address),
    redisOptions: {
      tls: {},
    },
  },
);

// Handle connection events
rlIoRedisClient.on('error', (error) => {
  logger.error('[rateLimiterCache] Redis connection error:', { error });
});

rlIoRedisClient.defineCommand('getOrCreateBucket', {
  numberOfKeys: 1,
  lua: fs.readFileSync(
    path.join(__dirname, 'redis-lua/get-or-create-bucket.lua'),
    'utf8',
  ),
});

rlIoRedisClient.defineCommand('consumeTokens', {
  numberOfKeys: 1,
  lua: fs.readFileSync(
    path.join(__dirname, 'redis-lua/consume-tokens.lua'),
    'utf8',
  ),
});
