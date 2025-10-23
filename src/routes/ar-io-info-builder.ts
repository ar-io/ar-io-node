/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * ANS-104 bundle filter configuration.
 * Controls which bundles are processed based on allow/deny lists.
 */
export interface BundleFilter {
  allow?: string[];
  deny?: string[];
  [key: string]: unknown;
}

/**
 * Rate limiter bucket configuration exposed in the info endpoint.
 */
export interface RateLimiterBucketInfo {
  capacity: number;
  refillRate: number;
  capacityBytes: number;
  refillRateBytesPerSec: number;
}

/**
 * Rate limiter configuration exposed in the info endpoint.
 */
export interface RateLimiterInfo {
  enabled: true;
  dataEgress: {
    buckets: {
      resource: RateLimiterBucketInfo;
      ip: RateLimiterBucketInfo;
    };
  };
}

/**
 * x402 pricing information exposed in the info endpoint.
 *
 * Note: Price fields are formatted as strings to avoid scientific notation
 * in JSON serialization (e.g., 0.0000000001 would serialize as 1e-10).
 */
export interface X402PricingInfo {
  perBytePrice: string;
  minPrice: string;
  maxPrice: string;
  currency: 'USDC';
  exampleCosts: {
    '1KB': number;
    '1MB': number;
    '1GB': number;
  };
}

/**
 * x402 payment configuration exposed in the info endpoint.
 */
export interface X402Info {
  enabled: true;
  network: string;
  walletAddress: string | undefined;
  facilitatorUrl: string;
  dataEgress: {
    pricing: X402PricingInfo;
    rateLimiterCapacityMultiplier: number;
  };
}

/**
 * Complete AR.IO info endpoint response structure.
 */
export interface ArIoInfoResponse {
  wallet: string | undefined;
  processId: string | undefined;
  ans104UnbundleFilter: BundleFilter;
  ans104IndexFilter: BundleFilter;
  supportedManifestVersions: string[];
  release: string;
  rateLimiter?: RateLimiterInfo;
  x402?: X402Info;
}

/**
 * Configuration input for building the AR.IO info response.
 */
export interface ArIoInfoConfig {
  wallet: string | undefined;
  processId: string | undefined;
  ans104UnbundleFilter: BundleFilter;
  ans104IndexFilter: BundleFilter;
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
    walletAddress: string | undefined;
    facilitatorUrl: string;
    perBytePrice: number;
    minPrice: number;
    maxPrice: number;
    capacityMultiplier: number;
  };
}

/**
 * Builds the AR.IO info endpoint response object.
 *
 * This pure function constructs the response for the /ar-io/info endpoint,
 * including optional rate limiter and x402 payment configuration when enabled.
 *
 * @param config - Configuration object containing gateway settings
 * @returns Complete AR.IO info response object
 *
 * @example
 * ```typescript
 * const info = buildArIoInfo({
 *   wallet: 'wallet-address',
 *   processId: 'process-id',
 *   ans104UnbundleFilter: {},
 *   ans104IndexFilter: {},
 *   release: 'r123',
 *   rateLimiter: {
 *     enabled: true,
 *     resourceCapacity: 1000000,
 *     resourceRefillRate: 100,
 *     ipCapacity: 100000,
 *     ipRefillRate: 20,
 *   },
 * });
 * ```
 */
export function buildArIoInfo(config: ArIoInfoConfig): ArIoInfoResponse {
  const response: ArIoInfoResponse = {
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

    // Calculate example costs (rounded to 6 decimals to match USDC precision)
    const cost1KB = Number(Math.max(perBytePrice * 1024, minPrice).toFixed(6));
    const cost1MB = Number(
      Math.max(perBytePrice * 1048576, minPrice).toFixed(6),
    );
    const cost1GB = Number(
      Math.min(Math.max(perBytePrice * 1073741824, minPrice), maxPrice).toFixed(
        6,
      ),
    );

    response.x402 = {
      enabled: true,
      network,
      walletAddress,
      facilitatorUrl,
      dataEgress: {
        pricing: {
          // Format as strings to avoid scientific notation in JSON (e.g., 1e-10)
          perBytePrice: perBytePrice.toFixed(10),
          minPrice: minPrice.toFixed(6),
          maxPrice: maxPrice.toFixed(6),
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
