/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { calculateX402Price } from '../payments/x402-pricing.js';

/**
 * ANS-104 bundle filter configuration.
 * Controls which bundles are processed based on allow/deny lists.
 */
/**
 * A price as a plain decimal string, never in exponent form and never
 * rounded away: every significant digit of the configured value, trailing
 * zeros trimmed.
 */
export function plainDecimal(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // Twelve significant digits drop float noise (1e-10 * 3 = 3.0000000000000004e-10)
  // without losing any digit an operator could have typed.
  const rounded = Number(value.toPrecision(12));
  const fixed = rounded.toFixed(20);
  return fixed.includes('.')
    ? fixed.replace(/0+$/, '').replace(/\.$/, '')
    : fixed;
}

export interface BundleFilter {
  allow?: string[];
  deny?: string[];
  [key: string]: unknown;
}

/**
 * Bundler service information exposed in the info endpoint.
 */
export interface BundlerInfo {
  url: string;
}

/**
 * Services configuration exposed in the info endpoint.
 */
export interface ServicesInfo {
  bundlers: BundlerInfo[];
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
 * HTTPSIG response signing configuration exposed in the info endpoint.
 * Presence of this field means the gateway signs qualifying responses per
 * RFC 9421. Verifiers can look up `solanaAddress` in the on-chain GAR to
 * confirm the signing key belongs to a registered gateway.
 */
export interface HttpsigInfo {
  algorithm: string;
  solanaAddress: string;
}

/**
 * Index artifacts this gateway publishes, for discovery by other gateways.
 * Present only while a valid publication exists. `manifestUrl` is where the
 * signed publication document lives; `names` lets a crawler decide whether
 * a publisher offers anything it wants without fetching the document.
 */
export interface IndexesInfo {
  manifestUrl: string;
  names: string[];
}

/**
 * Solana program IDs for the AR.IO Network suite. Each is a base58-encoded
 * Solana pubkey.
 */
export interface SolanaProgramIds {
  core: string | undefined;
  gar: string | undefined;
  arns: string | undefined;
  ant: string | undefined;
}

/**
 * Complete AR.IO info endpoint response structure.
 */
export interface ArIoInfoResponse {
  wallet: string | undefined;
  programIds: SolanaProgramIds;
  ans104UnbundleFilter: BundleFilter;
  ans104IndexFilter: BundleFilter;
  supportedManifestVersions: string[];
  release: string;
  services: ServicesInfo;
  rateLimiter?: RateLimiterInfo;
  x402?: X402Info;
  httpsig?: HttpsigInfo;
  indexes?: IndexesInfo;
}

/**
 * Configuration input for building the AR.IO info response.
 */
export interface ArIoInfoConfig {
  wallet: string | undefined;
  programIds: SolanaProgramIds;
  ans104UnbundleFilter: BundleFilter;
  ans104IndexFilter: BundleFilter;
  release: string;
  bundlerUrls: string[];
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
  httpsig?: {
    algorithm: string;
    solanaAddress: string;
  };
  /** Names of the indexes currently published; omitted when none. */
  indexNames?: string[];
}

/**
 * Builds the AR.IO info endpoint response object.
 *
 * This pure function constructs the response for the /ar-io/info endpoint,
 * including bundler service URLs and optional rate limiter and x402 payment
 * configuration when enabled.
 *
 * @param config - Configuration object containing gateway settings
 * @returns Complete AR.IO info response object
 *
 * @example
 * ```typescript
 * const info = buildArIoInfo({
 *   wallet: 'wallet-address',
 *   ans104UnbundleFilter: {},
 *   ans104IndexFilter: {},
 *   release: 'r123',
 *   bundlerUrls: ['https://turbo.ardrive.io/'],
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
    programIds: config.programIds,
    ans104UnbundleFilter: config.ans104UnbundleFilter,
    ans104IndexFilter: config.ans104IndexFilter,
    supportedManifestVersions: ['0.1.0', '0.2.0'],
    release: config.release,
    services: {
      bundlers: config.bundlerUrls.map((url) => ({ url })),
    },
  };

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
    const cost1KB = Number(
      calculateX402Price(1024, {
        perBytePrice,
        minPrice,
        maxPrice,
      }).toFixed(6),
    );
    const cost1MB = Number(
      calculateX402Price(1048576, {
        perBytePrice,
        minPrice,
        maxPrice,
      }).toFixed(6),
    );
    const cost1GB = Number(
      calculateX402Price(1073741824, {
        perBytePrice,
        minPrice,
        maxPrice,
      }).toFixed(6),
    );

    response.x402 = {
      enabled: true,
      network,
      walletAddress,
      facilitatorUrl,
      dataEgress: {
        pricing: {
          // A plain decimal string: JSON would otherwise carry 1e-10, and a
          // fixed number of places rounds a small price to zero (turbo's
          // 4.2e-11 advertised as "0.0000000000").
          perBytePrice: plainDecimal(perBytePrice),
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

  if (config.httpsig !== undefined) {
    response.httpsig = {
      algorithm: config.httpsig.algorithm,
      solanaAddress: config.httpsig.solanaAddress,
    };
  }

  if (config.indexNames !== undefined && config.indexNames.length > 0) {
    response.indexes = {
      manifestUrl: '/ar-io/indexes',
      names: config.indexNames,
    };
  }

  return response;
}
