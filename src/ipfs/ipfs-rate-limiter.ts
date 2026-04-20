/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import * as config from '../config.js';
import { MemoryRateLimiter } from '../limiter/memory-rate-limiter.js';

/**
 * Creates a separate MemoryRateLimiter instance for IPFS requests.
 * This ensures IPFS traffic doesn't compete with Arweave traffic
 * for rate-limit tokens.
 */
export function createIpfsRateLimiter(): MemoryRateLimiter {
  return new MemoryRateLimiter({
    resourceCapacity: config.IPFS_RATE_LIMITER_RESOURCE_TOKENS_PER_BUCKET,
    resourceRefillRate: config.IPFS_RATE_LIMITER_RESOURCE_REFILL_PER_SEC,
    ipCapacity: config.IPFS_RATE_LIMITER_IP_TOKENS_PER_BUCKET,
    ipRefillRate: config.IPFS_RATE_LIMITER_IP_REFILL_PER_SEC,
    limitsEnabled: config.ENABLE_RATE_LIMITER && config.IPFS_ENABLED,
    ipAllowlist: config.RATE_LIMITER_IPS_AND_CIDRS_ALLOWLIST,
    capacityMultiplier: 1,
    maxBuckets: 50000,
  });
}
