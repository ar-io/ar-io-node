/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as config from '../config.js';
import log from '../log.js';
import { RateLimiter } from './types.js';
import { MemoryRateLimiter } from './memory-rate-limiter.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';

/**
 * Create a rate limiter based on configuration
 *
 * @returns RateLimiter instance (Memory or Redis)
 */
export function createRateLimiter(): RateLimiter {
  const limiterType = config.RATE_LIMITER_TYPE;

  log.info('[RateLimiter] Creating rate limiter', { type: limiterType });

  switch (limiterType) {
    case 'memory':
      return new MemoryRateLimiter({
        resourceCapacity: config.RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET,
        resourceRefillRate: config.RATE_LIMITER_RESOURCE_REFILL_PER_SEC,
        ipCapacity: config.RATE_LIMITER_IP_TOKENS_PER_BUCKET,
        ipRefillRate: config.RATE_LIMITER_IP_REFILL_PER_SEC,
        limitsEnabled: config.ENABLE_RATE_LIMITER,
        ipAllowlist: config.RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST,
        capacityMultiplier: config.X_402_RATE_LIMIT_CAPACITY_MULTIPLIER,
        maxBuckets: 100000, // Default max buckets for memory limiter
      });

    case 'redis':
      return new RedisRateLimiter({
        resourceCapacity: config.RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET,
        resourceRefillRate: config.RATE_LIMITER_RESOURCE_REFILL_PER_SEC,
        ipCapacity: config.RATE_LIMITER_IP_TOKENS_PER_BUCKET,
        ipRefillRate: config.RATE_LIMITER_IP_REFILL_PER_SEC,
        cacheTtlSeconds: config.RATE_LIMITER_CACHE_TTL_SECONDS,
        limitsEnabled: config.ENABLE_RATE_LIMITER,
        ipAllowlist: config.RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST,
        capacityMultiplier: config.X_402_RATE_LIMIT_CAPACITY_MULTIPLIER,
      });

    default:
      log.warn(
        '[RateLimiter] Unknown rate limiter type, defaulting to memory',
        {
          type: limiterType,
        },
      );
      return new MemoryRateLimiter({
        resourceCapacity: config.RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET,
        resourceRefillRate: config.RATE_LIMITER_RESOURCE_REFILL_PER_SEC,
        ipCapacity: config.RATE_LIMITER_IP_TOKENS_PER_BUCKET,
        ipRefillRate: config.RATE_LIMITER_IP_REFILL_PER_SEC,
        limitsEnabled: config.ENABLE_RATE_LIMITER,
        ipAllowlist: config.RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST,
        capacityMultiplier: config.X_402_RATE_LIMIT_CAPACITY_MULTIPLIER,
        maxBuckets: 100000,
      });
  }
}
