/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export interface ArIoInfoConfig {
  wallet: string;
  processId: string;
  ans104UnbundleFilter: any;
  ans104IndexFilter: any;
  release: string;
  rateLimiter?: {
    enabled: boolean;
    resourceCapacity: number;
    resourceRefillRate: number;
    ipCapacity: number;
    ipRefillRate: number;
  };
  x402?: {
    enabled: boolean;
    network: string;
    walletAddress: string;
    facilitatorUrl: string;
    perBytePrice: number;
    minPrice: number;
    maxPrice: number;
    capacityMultiplier: number;
  };
}

export function buildArIoInfo(config: ArIoInfoConfig) {
  const response: any = {
    wallet: config.wallet,
    processId: config.processId,
    ans104UnbundleFilter: config.ans104UnbundleFilter,
    ans104IndexFilter: config.ans104IndexFilter,
    supportedManifestVersions: ['0.1.0', '0.2.0'],
    release: config.release,
  };

  // Add rate limiter info if enabled
  if (config.rateLimiter?.enabled) {
    const { resourceCapacity, resourceRefillRate, ipCapacity, ipRefillRate } =
      config.rateLimiter;

    response.rateLimiter = {
      enabled: true,
      dataEgress: {
        buckets: {
          resource: {
            capacity: resourceCapacity,
            refillRate: resourceRefillRate,
            capacityBytes: resourceCapacity * 1024,
            refillRateBytesPerSec: resourceRefillRate * 1024,
          },
          ip: {
            capacity: ipCapacity,
            refillRate: ipRefillRate,
            capacityBytes: ipCapacity * 1024,
            refillRateBytesPerSec: ipRefillRate * 1024,
          },
        },
      },
    };
  }

  // Add x402 payment info if enabled
  if (config.x402?.enabled) {
    const {
      network,
      walletAddress,
      facilitatorUrl,
      perBytePrice,
      minPrice,
      maxPrice,
      capacityMultiplier,
    } = config.x402;

    // Calculate example costs
    const cost1KB = Math.max(perBytePrice * 1024, minPrice);
    const cost1MB = Math.max(perBytePrice * 1048576, minPrice);
    const cost1GB = Math.min(
      Math.max(perBytePrice * 1073741824, minPrice),
      maxPrice,
    );

    response.x402 = {
      enabled: true,
      network,
      walletAddress,
      facilitatorUrl,
      dataEgress: {
        pricing: {
          perBytePrice,
          minPrice,
          maxPrice,
          currency: 'USDC',
          exampleCosts: {
            '1KB': cost1KB,
            '1MB': cost1MB,
            '1GB': cost1GB,
          },
        },
        rateLimiterCapacityMultiplier: capacityMultiplier,
      },
    };
  }

  return response;
}
